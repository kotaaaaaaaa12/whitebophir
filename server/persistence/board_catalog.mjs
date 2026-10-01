import { readdir } from "node:fs/promises";
import { CATALOG_PAGE_SIZE } from "../../client-data/js/board_catalog_constants.js";
import { isValidBoardName } from "../../client-data/js/board_name.js";
import { listLoadedBoards } from "../board/registry.mjs";
import { readBoardLifecycle } from "./board_lifecycle.mjs";
import { storageRequest } from "./cloud_storage.mjs";

/** @import { ServerConfig } from "../../types/server-runtime.d.ts" */

/**
 * Include saved, backup-only, loaded and empty created boards. Never recreate
 * a deleted board or inspect its drawing content just to build the catalog.
 * @param {ServerConfig} config @param {{after: string, query: string}} options
 * @returns {Promise<{names: string[], nextCursor: string | null}>}
 */
export async function listBoardCatalog(config, { after, query }) {
  if (process.env.WBO_CLOUD_STORAGE_URL) {
    const search = new URLSearchParams({ after, q: query });
    const response = await storageRequest(`/catalog?${search}`);
    return response.json();
  }
  const names = new Set(listLoadedBoards());
  for (const file of await readdir(config.HISTORY_DIR)) {
    const match =
      /^board-(.+?)\.(?:svg(?:\.bak)?|json(?:\.bak)?|owner\.json|chat\.sqlite)$/.exec(
        file,
      );
    if (match?.[1] && isValidBoardName(match[1])) names.add(match[1]);
  }
  const page = [];
  for (const name of [...names].sort()) {
    if (name <= after || !name.includes(query) || !isValidBoardName(name))
      continue;
    if ((await readBoardLifecycle(name, config))?.deleted) continue;
    page.push(name);
    if (page.length > CATALOG_PAGE_SIZE) break;
  }
  return {
    names: page.slice(0, CATALOG_PAGE_SIZE),
    nextCursor:
      page.length > CATALOG_PAGE_SIZE
        ? page[CATALOG_PAGE_SIZE - 1] || null
        : null,
  };
}
