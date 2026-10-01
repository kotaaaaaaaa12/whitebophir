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
} from "../persistence/chat_store.mjs";
import {
  assertBoardActive,
  isBoardDeleting,
} from "../persistence/board_lifecycle.mjs";
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
/** @import { ChatSendResult, ChatHistoryResult } from "../../client-data/js/chat_protocol.js" */
/** @typedef {{windowStart: number, count: number, lastSeen: number}} ChatRateState */
/** @type {WeakMap<ServerConfig, Map<string, ChatRateState>>} */
const rateMaps = new WeakMap();
/** @type {WeakMap<AppSocket, () => number | null>} */
const administratorSessions = new WeakMap();

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
    ack({ ok: true, ...page });
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
    const message = await saveChatMessage(board, config, {
      author: createHash("sha256")
        .update(user.userSecret || user.ip)
        .digest("hex"),
      clientId: input.clientId,
      name: `${isAdministrator(socket, config) ? "🌸" : ""}${user.name}`,
      text,
      sentAt: Date.now(),
    });
    await assertBoardActive(board, config);
    if (!viewer(socket, board, config))
      return ack({ ok: false, error: "chat_unavailable" });
    // Broadcast only after durable storage acknowledges the message. A retry of
    // the same nonce returns the same ID; receivers deduplicate it by that ID.
    socket.emit(SocketEvents.CHAT_MESSAGE, message);
    socket.broadcast.to(board).emit(SocketEvents.CHAT_MESSAGE, message);
    ack({ ok: true, message });
  } catch (error) {
    console.error("chat.send_failed", error);
    ack({ ok: false, error: "chat_send_failed" });
  }
}
