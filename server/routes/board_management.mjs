import { getUserSecretFromCookieHeader } from "../auth/user_secret_cookie.mjs";
import {
  eraseBoard,
  isProtectedBoard,
  ownerDigest,
  readBoardLifecycle,
  validBoardAdminKey,
} from "../persistence/board_lifecycle.mjs";
import { freezeBoardForDeletion } from "../socket/index.mjs";
import {
  boardPermissionsForRequest,
  requireBoardPathName,
} from "./board_http_helpers.mjs";

/** @import { HttpRouteContext } from "../../types/server-runtime.d.ts" */

/** @param {HttpRouteContext} ctx @returns {Promise<void>} */
export async function manageBoard(ctx) {
  const name = requireBoardPathName(ctx.params);
  const config = ctx.runtime.config;
  boardPermissionsForRequest(ctx, name).requireOpen();
  const state = await readBoardLifecycle(name, config);
  const secret = getUserSecretFromCookieHeader(ctx.request.headers.cookie);
  const owned = !!secret && state?.owner === ownerDigest(secret);
  const protectedBoard = isProtectedBoard(name, config);
  ctx.response.setHeader("Cache-Control", "private, no-store");
  ctx.response.setHeader("Content-Type", "application/json");
  if (ctx.request.method === "GET") {
    ctx.response.end(
      JSON.stringify({
        canDelete: owned && !protectedBoard,
        protected: protectedBoard,
        deleted: !!state?.deleted,
        adminKeyEnabled: !!config.BOARD_ADMIN_KEY,
      }),
    );
    return;
  }
  if (ctx.request.method !== "DELETE") {
    ctx.response.writeHead(405, { Allow: "GET, DELETE" });
    ctx.response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  if (
    ctx.request.headers["x-wbo-delete"] !== "1" ||
    ctx.request.headers["sec-fetch-site"] === "cross-site"
  ) {
    ctx.response.writeHead(403);
    ctx.response.end(
      JSON.stringify({ error: "deletion_confirmation_required" }),
    );
    return;
  }
  if (
    protectedBoard ||
    (!owned &&
      !validBoardAdminKey(ctx.request.headers["x-board-admin-key"], config))
  ) {
    ctx.response.writeHead(403);
    ctx.response.end(
      JSON.stringify({
        error: protectedBoard ? "protected_board" : "owner_or_admin_required",
      }),
    );
    return;
  }
  await eraseBoard(name, config, () => freezeBoardForDeletion(name));
  ctx.response.writeHead(204);
  ctx.response.end();
}
