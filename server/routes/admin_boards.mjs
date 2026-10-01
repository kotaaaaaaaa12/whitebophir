import { ADMIN_TRANSLATIONS } from "../../client-data/js/admin_i18n.js";
import { isValidBoardName } from "../../client-data/js/board_name.js";
import {
  adminSessionExpiry,
  adminSessionFromCookie,
} from "../auth/admin_session.mjs";
import { getUserSecretFromCookieHeader } from "../auth/user_secret_cookie.mjs";
import { publicPath } from "../http/request_url.mjs";
import { listBoardCatalog } from "../persistence/board_catalog.mjs";
import { isProtectedBoard } from "../persistence/board_lifecycle.mjs";
import { ensureBoardUserSecretCookie } from "./board_http_helpers.mjs";

/** @import { HttpRouteContext } from "../../types/server-runtime.d.ts" */

/** @param {HttpRouteContext} ctx */
export async function serveAdminPage(ctx) {
  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") {
    ctx.response.writeHead(405, { Allow: "GET, HEAD" });
    ctx.response.end();
    return;
  }
  const config = ctx.runtime.config;
  // This generic shell contains no board metadata. The API checks the signed
  // admin session before listing names; visiting here only establishes identity.
  ensureBoardUserSecretCookie(
    ctx.request,
    ctx.response,
    ctx.publicUrl,
    publicPath(config, "/"),
  );
  const template = ctx.runtime.adminTemplate;
  const parameters = template.parameters(ctx.publicUrl, ctx.request, false);
  const language = parameters.language === "ja" ? "ja" : "en";
  const html = template.render({
    language,
    baseHref: publicPath(config, "/"),
    admin: ADMIN_TRANSLATIONS[language],
  });
  ctx.response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
    Vary: "Cookie, Accept-Language",
  });
  ctx.response.end(ctx.request.method === "HEAD" ? undefined : html);
}

/** @param {HttpRouteContext} ctx */
export async function listAdminBoards(ctx) {
  const { request, response } = ctx;
  const config = ctx.runtime.config;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Vary", "Cookie");
  const secret = getUserSecretFromCookieHeader(request.headers.cookie);
  if (
    adminSessionExpiry(
      adminSessionFromCookie(request.headers.cookie),
      secret,
      config,
    )() === null
  ) {
    response.writeHead(403);
    response.end(JSON.stringify({ error: "administrator_required" }));
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  const after = ctx.url.searchParams.get("after") || "";
  const query = (ctx.url.searchParams.get("q") || "").trim().toLowerCase();
  if ((after && !isValidBoardName(after)) || query.length > 100) {
    response.writeHead(400);
    response.end(JSON.stringify({ error: "invalid_catalog_query" }));
    return;
  }
  const page = await listBoardCatalog(config, { after, query });
  response.end(
    JSON.stringify({
      boards: page.names.map((name) => ({
        name,
        protected: isProtectedBoard(name, config),
      })),
      nextCursor: page.nextCursor,
    }),
  );
}
