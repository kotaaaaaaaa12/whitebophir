import { createHash } from "node:crypto";
import {
  normalizeChatText,
  validChatClientId,
  validChatCursor,
} from "../../client-data/js/chat_protocol.js";
import RateLimitCommon from "../../client-data/js/rate_limit_common.js";
import { SocketEvents } from "../../client-data/js/socket_events.js";
import {
  readChatHistory,
  saveChatMessage,
  deleteChatMessage,
} from "../persistence/chat_store.mjs";
import {
  assertBoardActive,
  isBoardDeleting,
} from "../persistence/board_lifecycle.mjs";
import { SerialTaskQueue } from "../board/serial_task_queue.mjs";
import { capToMaxSize, pruneStaleEntries } from "./bounded_state_map.mjs";
import { canAccessBoard, canReportOnBoard, canBanOnBoard } from "./policy.mjs";
import { getBoardUser } from "./presence.mjs";
import {
  adminSessionExpiry,
  adminSessionFromCookie,
} from "../auth/admin_session.mjs";
import { getSocketHeaderValue, getSocketUserSecret } from "./request.mjs";
import { isTurnstileValidationActive } from "./turnstile.mjs";

/** @import { AppSocket, ServerConfig } from "../../types/server-runtime.d.ts" */
/** @import { ChatSendResult, ChatHistoryResult, ChatDeleteResult } from "../../client-data/js/chat_protocol.js" */
/** @typedef {{windowStart: number, count: number, lastSeen: number}} ChatRateState */
/** @type {WeakMap<ServerConfig, Map<string, ChatRateState>>} */
const rateMaps = new WeakMap();
/** @type {WeakMap<AppSocket, () => number | null>} */
const administratorSessions = new WeakMap();
/** @type {WeakMap<ServerConfig, Map<string, {queue: SerialTaskQueue, count: number}>>} */
const mutations = new WeakMap();

/** @template T @param {ServerConfig} config @param {string} board @param {() => Promise<T>} task */
async function orderedMutation(config, board, task) {
  let rooms = mutations.get(config);
  if (!rooms) {
    rooms = new Map();
    mutations.set(config, rooms);
  }
  let state = rooms.get(board);
  if (!state) {
    state = { queue: new SerialTaskQueue(), count: 0 };
    rooms.set(board, state);
  }
  state.count++;
  try {
    return await state.queue.runExclusive(task);
  } finally {
    if (--state.count === 0) rooms.delete(board);
  }
}

/** @param {AppSocket} socket @param {ServerConfig} config */
function isAdministrator(socket, config) {
  let expiry = administratorSessions.get(socket);
  if (!expiry) {
    expiry = adminSessionExpiry(
      adminSessionFromCookie(getSocketHeaderValue(socket, "cookie")),
      getSocketUserSecret(socket),
      config,
    );
    administratorSessions.set(socket, expiry);
  }
  return expiry() !== null;
}

/** @param {ServerConfig} config @param {string} key @param {number} limit */
function rateAllowed(config, key, limit) {
  let states = rateMaps.get(config);
  if (!states) {
    states = new Map();
    rateMaps.set(config, states);
  }
  const now = Date.now();
  pruneStaleEntries(
    states,
    (state) => RateLimitCommon.isRateLimitStateStale(state, 10_000, now),
    16,
  );
  const next = RateLimitCommon.consumeFixedWindowRateLimit(
    states.get(key),
    1,
    10_000,
    now,
  );
  states.delete(key);
  states.set(key, next);
  capToMaxSize(states, 4096);
  return next.count <= limit;
}

/** @param {AppSocket} socket @param {string} board @param {ServerConfig} config */
function viewer(socket, board, config) {
  return socket.connected &&
    socket.rooms.has(board) &&
    canAccessBoard(config, board, socket)
    ? getBoardUser(board, socket.id)
    : undefined;
}

/** @param {AppSocket} socket @param {string} board @param {ServerConfig} config @param {unknown} payload @param {(result: ChatHistoryResult) => void} ack */
export async function handleChatHistory(socket, board, config, payload, ack) {
  if (typeof ack !== "function") return;
  try {
    const user = viewer(socket, board, config);
    if (!user) return ack({ ok: false, error: "chat_unavailable" });
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return ack({ ok: false, error: "chat_history_failed" });
    const before = /** @type {{before?: unknown}} */ (payload).before;
    if (before !== undefined && !validChatCursor(before))
      return ack({ ok: false, error: "chat_history_failed" });
    if (!rateAllowed(config, `history:${board}:${user.ip}`, 20))
      return ack({ ok: false, error: "chat_rate_limited" });
    const page = await readChatHistory(
      board,
      config,
      typeof before === "number" ? before : undefined,
    );
    if (!viewer(socket, board, config) || isBoardDeleting(board, config))
      return ack({ ok: false, error: "chat_unavailable" });
    ack({ ok: true, ...page, canDelete: isAdministrator(socket, config) });
  } catch (error) {
    console.error("chat.history_failed", error);
    ack({ ok: false, error: "chat_history_failed" });
  }
}

/** @param {AppSocket} socket @param {string} board @param {ServerConfig} config @param {unknown} payload @param {(result: ChatSendResult) => void} ack */
export async function handleChatSend(socket, board, config, payload, ack) {
  if (typeof ack !== "function") return;
  try {
    const user = viewer(socket, board, config);
    if (!user || !canReportOnBoard(config, board, socket))
      return ack({ ok: false, error: "chat_unavailable" });
    if (!payload || typeof payload !== "object")
      return ack({ ok: false, error: "chat_invalid" });
    const input = /** @type {{clientId?: unknown, text?: unknown}} */ (payload);
    const text = normalizeChatText(input.text);
    if (text === null || !validChatClientId(input.clientId))
      return ack({ ok: false, error: "chat_invalid" });
    if (!rateAllowed(config, `send:${board}:${user.ip}`, 5))
      return ack({ ok: false, error: "chat_rate_limited" });
    if (
      board === "anonymous" &&
      config.TURNSTILE_SITE_KEY &&
      !canBanOnBoard(config, board, socket) &&
      !isTurnstileValidationActive(socket, Date.now())
    )
      return ack({ ok: false, error: "chat_verification_required" });
    const clientId = input.clientId;
    await orderedMutation(config, board, async () => {
      if (
        !viewer(socket, board, config) ||
        !canReportOnBoard(config, board, socket)
      )
        return ack({ ok: false, error: "chat_unavailable" });
      const message = await saveChatMessage(board, config, {
        author: createHash("sha256")
          .update(user.userSecret || user.ip)
          .digest("hex"),
        clientId,
        name: `${isAdministrator(socket, config) ? "🌸" : ""}${user.name}`,
        text,
        sentAt: Date.now(),
      });
      await assertBoardActive(board, config);
      if (!viewer(socket, board, config))
        return ack({ ok: false, error: "chat_unavailable" });
      // Broadcast only after durable storage acknowledges the message. A retry of
      // the same nonce returns the same ID; receivers deduplicate it by that ID.
      // The live sender marker never enters stored history or another viewer's event.
      socket.emit(SocketEvents.CHAT_MESSAGE, { ...message, own: true });
      socket.broadcast.to(board).emit(SocketEvents.CHAT_MESSAGE, message);
      ack({ ok: true, message });
    });
  } catch (error) {
    console.error("chat.send_failed", error);
    ack({ ok: false, error: "chat_send_failed" });
  }
}

/** @param {AppSocket} socket @param {string} board @param {ServerConfig} config @param {unknown} payload @param {(result: ChatDeleteResult) => void} ack */
export async function handleChatDelete(socket, board, config, payload, ack) {
  if (typeof ack !== "function") return;
  try {
    const user = viewer(socket, board, config);
    if (!user || !isAdministrator(socket, config))
      return ack({ ok: false, error: "chat_delete_forbidden" });
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return ack({ ok: false, error: "chat_delete_failed" });
    const id = /** @type {{id?: unknown}} */ (payload).id;
    if (!validChatCursor(id))
      return ack({ ok: false, error: "chat_delete_failed" });
    if (!rateAllowed(config, `delete:${board}:${user.ip}`, 20))
      return ack({ ok: false, error: "chat_rate_limited" });
    await orderedMutation(config, board, async () => {
      if (!viewer(socket, board, config) || !isAdministrator(socket, config))
        return ack({ ok: false, error: "chat_delete_forbidden" });
      if (!(await deleteChatMessage(board, config, id)))
        return ack({ ok: false, error: "chat_delete_failed" });
      await assertBoardActive(board, config);
      if (!viewer(socket, board, config))
        return ack({ ok: false, error: "chat_unavailable" });
      socket.emit(SocketEvents.CHAT_DELETED, { id });
      socket.broadcast.to(board).emit(SocketEvents.CHAT_DELETED, { id });
      ack({ ok: true, id });
    });
  } catch (error) {
    console.error("chat.delete_failed", error);
    ack({ ok: false, error: "chat_delete_failed" });
  }
}
