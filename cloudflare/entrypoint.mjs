import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BoardData } from "../server/board/data.mjs";
import * as config from "../server/configuration.mjs";
import { isValidBoardName } from "../client-data/js/board_name.js";
import { boardSvgPath } from "../server/persistence/svg_board_paths.mjs";
import { storageRequest } from "../server/persistence/cloud_storage.mjs";
import { createServerApp } from "../server/server.mjs";

// Recovery completes before the HTTP server or Socket.IO accepts any clients.
await mkdir(config.HISTORY_DIR, { recursive: true });
let cursor = "";
do {
  const response = await storageRequest(
    `/boards?after=${encodeURIComponent(cursor)}`,
  );
  const names = await response.json();
  if (!Array.isArray(names)) throw new Error("Invalid board catalog");
  for (const name of names) {
    if (!isValidBoardName(name)) throw new Error("Invalid stored board name");
    const encoded = encodeURIComponent(name);
    const snapshot = await storageRequest(`/restore/${encoded}`);
    const snapshotSeq = Number(snapshot.headers.get("x-snapshot-seq"));
    if (snapshotSeq > 0 || snapshot.status === 200) {
      if (!snapshot.body) throw new Error("Missing snapshot body");
      await pipeline(
        Readable.fromWeb(snapshot.body),
        createWriteStream(boardSvgPath(name, config.HISTORY_DIR)),
      );
    }
    const board = await BoardData.load(name, {
      ...config,
      SAVE_INTERVAL: 1_000_000_000,
      MAX_SAVE_DELAY: 1_000_000_000,
    });
    if (board.getSeq() !== snapshotSeq)
      throw new Error(`Invalid snapshot for ${name}`);
    let afterSeq = board.getSeq();
    for (;;) {
      const log = await storageRequest(`/journal/${encoded}?after=${afterSeq}`);
      const entries = await log.json();
      if (!Array.isArray(entries)) throw new Error("Invalid mutation journal");
      if (entries.length === 0) break;
      for (const entry of entries) {
        if (entry.seq !== board.getSeq() + 1)
          throw new Error("Mutation sequence gap");
        const prepared = await board.preparePersistentMutation(entry.mutation);
        const mutation =
          prepared.ok && prepared.mutation ? prepared.mutation : entry.mutation;
        const result = board.processMessage(mutation);
        // Overflow cleanup may already have applied a recorded delete effect.
        const alreadyDeleted =
          mutation.type === 3 &&
          (!board.itemsById.has(mutation.id) ||
            board.itemsById.get(mutation.id)?.deleted === true);
        if (!result.ok && !alreadyDeleted)
          throw new Error(
            `Cannot recover mutation ${entry.seq}: ${result.reason}`,
          );
        board.consumePendingAcceptedMutationEffects();
        board.consumePendingRejectedMutationEffects();
        board.recordPersistentMutation(mutation, entry.acceptedAtMs);
        board.clearSaveTimeout();
        afterSeq = entry.seq;
      }
    }
    if (board.getSeq() !== snapshotSeq) {
      const saved = await board.save();
      if (saved.status !== "saved")
        throw new Error(`Cannot save recovered board ${name}`);
    }
    board.dispose();
    cursor = name;
  }
  if (names.length < 100) break;
} while (cursor);
await createServerApp(config, { installShutdownHandlers: true });
