import {
  adminSessionExpiry,
  adminSessionFromCookie,
  createAdminSession,
  revokeAdminSession,
  serializeAdminCookie,
} from "../auth/admin_session.mjs";
import {
  appendSetCookieHeader,
  getUserSecretFromCookieHeader,
} from "../auth/user_secret_cookie.mjs";
import { requestScheme } from "../http/observation.mjs";
import { validBoardAdminKey } from "../persistence/board_lifecycle.mjs";
import { refreshBrowserAccess } from "../socket/index.mjs";
import { resolveRequestClientIpSafe } from "../socket/policy.mjs";

/** @import { HttpRouteContext, HttpRequest } from "../../types/server-runtime.d.ts" */
/** @type {Map<string, {count: number, until: number}>} */
const attempts = new Map();

/** @param {string} ip */
function allowAttempt(ip) {
  const now = Date.now();
  for (const [key, state] of attempts)
    if (state.until <= now) attempts.delete(key);
  const state = attempts.get(ip);
  if (state) return ++state.count <= 5;
  if (attempts.size >= 1024) return false;
  attempts.set(ip, { count: 1, until: now + 60_000 });
  return true;
}

/** @param {HttpRequest} request @returns {Promise<string | null>} */
function readBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        chunks.length = 0;
        resolve(null);
      } else chunks.push(Buffer.from(chunk));
    });
    request.on("end", () =>
      resolve(size > 4096 ? null : Buffer.concat(chunks).toString("utf8")),
    );
    request.on("error", () => resolve(null));
    request.on("aborted", () => resolve(null));
  });
}

/** @param {HttpRouteContext} ctx */
export async function manageAdminSession(ctx) {
  const { request, response } = ctx;
  const config = ctx.runtime.config;
  const secret = getUserSecretFromCookieHeader(request.headers.cookie);
  const token = adminSessionFromCookie(request.headers.cookie);
  const authenticated = adminSessionExpiry(token, secret, config)() !== null;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Type", "application/json");
  /** @param {number} status @param {object} value */
  const reply = (status, value) => {
    response.writeHead(status);
    response.end(JSON.stringify(value));
  };
  if (request.method === "GET") {
    reply(200, { enabled: !!config.BOARD_ADMIN_KEY, authenticated });
    return;
  }
  if (request.method !== "POST" && request.method !== "DELETE") {
    response.setHeader("Allow", "GET, POST, DELETE");
    reply(405, { error: "method_not_allowed" });
    return;
  }
  if (
    request.headers["x-wbo-admin"] !== "1" ||
    request.headers["sec-fetch-site"] === "cross-site"
  ) {
    reply(403, { error: "admin_confirmation_required" });
    return;
  }
  const options = {
    path: `${config.BASE_PATH || ""}/`,
    secure: requestScheme(request) === "https",
  };
  if (request.method === "DELETE") {
    if (authenticated) revokeAdminSession(token);
    appendSetCookieHeader(response, serializeAdminCookie("", options));
    response.writeHead(200);
    response.end(JSON.stringify({ authenticated: false }), () => {
      if (secret) refreshBrowserAccess(secret);
    });
    return;
  }
  if (!config.BOARD_ADMIN_KEY || !secret) {
    reply(403, { error: "admin_login_unavailable" });
    return;
  }
  if (!allowAttempt(resolveRequestClientIpSafe(config, request))) {
    response.setHeader("Retry-After", "60");
    reply(429, { error: "admin_login_rate_limited" });
    return;
  }
  if (
    !String(request.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    reply(415, { error: "json_required" });
    return;
  }
  const body = await readBody(request);
  if (body === null) {
    response.setHeader("Connection", "close");
    reply(413, { error: "body_too_large" });
    return;
  }
  let password;
  try {
    password = JSON.parse(body)?.password;
  } catch {
    reply(400, { error: "invalid_json" });
    return;
  }
  if (!validBoardAdminKey(password, config)) {
    reply(403, { error: "admin_login_failed" });
    return;
  }
  if (authenticated) revokeAdminSession(token);
  appendSetCookieHeader(
    response,
    serializeAdminCookie(createAdminSession(secret, config), options),
  );
  reply(200, { authenticated: true });
}
