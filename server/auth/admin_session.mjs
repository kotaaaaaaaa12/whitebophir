import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { parseCookieHeader } from "./user_secret_cookie.mjs";

export const ADMIN_COOKIE_NAME = "wbo-admin-v1";
export const ADMIN_SESSION_SECONDS = 7 * 24 * 60 * 60;
/** @typedef {{BOARD_ADMIN_KEY?: string}} AdminConfig */
/** @type {Map<string, number>} */
const revoked = new Map();
let revokedBefore = 0;

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string | string[] | undefined} header */
export function adminSessionFromCookie(header) {
  const token = parseCookieHeader(header)[ADMIN_COOKIE_NAME];
  return typeof token === "string" && token.length <= 300 ? token : "";
}

/** @param {string} secret @param {AdminConfig} config @param {number} [now] */
export function createAdminSession(secret, config, now = Date.now()) {
  if (!secret || !config.BOARD_ADMIN_KEY)
    throw new Error("Admin login unavailable");
  const payload = `1.${now}.${now + ADMIN_SESSION_SECONDS * 1000}.${randomBytes(16).toString("hex")}.${digest(secret)}`;
  const signature = createHmac("sha256", config.BOARD_ADMIN_KEY)
    .update(payload)
    .digest("hex");
  return `${payload}.${signature}`;
}

/**
 * Verify once per request/socket; mutation checks only consult expiry/revocation.
 * @param {string | null | undefined} token
 * @param {string | null | undefined} secret
 * @param {AdminConfig} config
 * @returns {() => number | null}
 */
export function adminSessionExpiry(token, secret, config) {
  if (!config.BOARD_ADMIN_KEY || !token || !secret || token.length > 300)
    return () => null;
  const match =
    /^1\.(\d{13})\.(\d{13})\.([0-9a-f]{32})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(
      token,
    );
  if (!match || !match[3] || !match[5] || match[4] !== digest(secret))
    return () => null;
  const signature = createHmac("sha256", config.BOARD_ADMIN_KEY)
    .update(token.slice(0, -65))
    .digest();
  if (!timingSafeEqual(signature, Buffer.from(match[5], "hex")))
    return () => null;
  const issuedAt = Number(match[1]);
  const expiresAt = Number(match[2]);
  if (
    issuedAt > Date.now() ||
    expiresAt - issuedAt !== ADMIN_SESSION_SECONDS * 1000
  )
    return () => null;
  const id = match[3];
  return () =>
    issuedAt <= revokedBefore || revoked.has(id) || expiresAt <= Date.now()
      ? null
      : expiresAt;
}

/** @param {string} token */
export function revokeAdminSession(token) {
  const parts = token.split(".");
  const now = Date.now();
  for (const [id, expiry] of revoked) if (expiry <= now) revoked.delete(id);
  // Bound process memory; overflow safely expires all older sessions.
  if (revoked.size >= 4096) {
    revokedBefore = now;
    revoked.clear();
  }
  if (parts[3]) revoked.set(parts[3], Number(parts[2]));
}

/** @param {string} token @param {{path: string, secure: boolean}} options */
export function serializeAdminCookie(token, options) {
  return `${ADMIN_COOKIE_NAME}=${token}; Path=${options.path}; Max-Age=${token ? ADMIN_SESSION_SECONDS : 0}; HttpOnly; SameSite=Strict${options.secure ? "; Secure" : ""}`;
}
