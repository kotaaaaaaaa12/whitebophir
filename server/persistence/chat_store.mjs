import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAT_PAGE_SIZE } from "../../client-data/js/chat_protocol.js";
import { BoundaryError } from "../http/boundary_errors.mjs";
import {
  assertBoardActive,
  isBoardDeleting,
  withActiveLocalBoard,
} from "./board_lifecycle.mjs";
import { storageRequest } from "./cloud_storage.mjs";

/** @import { ServerConfig } from "../../types/server-runtime.d.ts" */
/** @import { ChatInput, ChatMessage, ChatPage } from "../../client-data/js/chat_protocol.js" */

/** @param {string} name @param {ServerConfig} config */
export function chatDatabasePath(name, config) {
  return path.join(config.HISTORY_DIR, `board-${name}.chat.sqlite`);
}

/** @template T @param {string} name @param {ServerConfig} config @param {(db: DatabaseSync) => T} operation */
function withDatabase(name, config, operation) {
  // No awaits between the deletion recheck and a local read/write. Each short
  // operation closes its connection, so deletion can remove every SQLite file.
  if (isBoardDeleting(name, config))
    throw new BoundaryError(410, "board_deleted");
  mkdirSync(config.HISTORY_DIR, { recursive: true });
  const db = new DatabaseSync(chatDatabasePath(name, config));
  try {
    db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL, client_id TEXT NOT NULL,
        name TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL,
        UNIQUE(author, client_id)
      ); CREATE TABLE IF NOT EXISTS deleted_messages (
        id INTEGER PRIMARY KEY, author TEXT NOT NULL, client_id TEXT NOT NULL,
        UNIQUE(author, client_id)
      );`);
    return operation(db);
  } finally {
    db.close();
  }
}

/** @param {ChatMessage[]} rows @returns {ChatPage} */
export function chatPage(rows) {
  const page = rows.slice(0, CHAT_PAGE_SIZE).reverse();
  return {
    messages: page,
    nextBefore: rows.length > CHAT_PAGE_SIZE ? page[0]?.id || null : null,
  };
}

/** @param {string} name @param {ServerConfig} config @param {number} [before] @returns {Promise<ChatPage>} */
export async function readChatHistory(
  name,
  config,
  before = Number.MAX_SAFE_INTEGER,
) {
  if (process.env.WBO_CLOUD_STORAGE_URL) {
    await assertBoardActive(name, config);
    return (
      await storageRequest(`/chat/${encodeURIComponent(name)}?before=${before}`)
    ).json();
  }
  return withActiveLocalBoard(name, config, () =>
    withDatabase(name, config, (db) => {
      const rows = /** @type {ChatMessage[]} */ (
        db
          .prepare(
            "SELECT id, name, text, sent_at AS sentAt FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?",
          )
          .all(before, CHAT_PAGE_SIZE + 1)
      );
      return chatPage(rows);
    }),
  );
}

/** @param {string} name @param {ServerConfig} config @param {ChatInput} input @returns {Promise<ChatMessage>} */
export async function saveChatMessage(name, config, input) {
  if (process.env.WBO_CLOUD_STORAGE_URL) {
    await assertBoardActive(name, config);
    return (
      await storageRequest(`/chat/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    ).json();
  }
  return withActiveLocalBoard(name, config, () =>
    withDatabase(name, config, (db) => {
      if (
        db
          .prepare(
            "SELECT id FROM deleted_messages WHERE author = ? AND client_id = ?",
          )
          .get(input.author, input.clientId)
      )
        throw new BoundaryError(409, "chat_message_deleted");
      db.prepare(
        "INSERT OR IGNORE INTO messages (author, client_id, name, text, sent_at) VALUES (?, ?, ?, ?, ?)",
      ).run(input.author, input.clientId, input.name, input.text, input.sentAt);
      return /** @type {ChatMessage} */ (
        db
          .prepare(
            "SELECT id, name, text, sent_at AS sentAt FROM messages WHERE author = ? AND client_id = ?",
          )
          .get(input.author, input.clientId)
      );
    }),
  );
}

/** @param {string} name @param {ServerConfig} config @param {number} id @returns {Promise<boolean>} */
export async function deleteChatMessage(name, config, id) {
  if (process.env.WBO_CLOUD_STORAGE_URL) {
    await assertBoardActive(name, config);
    return (
      await storageRequest(`/chat/${encodeURIComponent(name)}?id=${id}`, {
        method: "DELETE",
      })
    ).json();
  }
  return withActiveLocalBoard(name, config, () =>
    withDatabase(name, config, (db) => {
      if (db.prepare("SELECT id FROM deleted_messages WHERE id = ?").get(id))
        return true;
      db.exec("BEGIN IMMEDIATE");
      try {
        const removed = db
          .prepare(
            "INSERT INTO deleted_messages (id, author, client_id) SELECT id, author, client_id FROM messages WHERE id = ?",
          )
          .run(id);
        db.prepare("DELETE FROM messages WHERE id = ?").run(id);
        db.exec("COMMIT");
        return Number(removed.changes) === 1;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }),
  );
}
