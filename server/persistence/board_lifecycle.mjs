import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { canonicalizeBoardName } from "../../client-data/js/board_name.js";
import { getLoadedBoard } from "../board/registry.mjs";
import { SerialTaskQueue } from "../board/serial_task_queue.mjs";
import { BoundaryError } from "../http/boundary_errors.mjs";
import { storageRequest } from "./cloud_storage.mjs";
import { boardExists } from "./svg_board_store.mjs";
import { boardSvgPath } from "./svg_board_paths.mjs";
import { boardJsonPath } from "./legacy_json_board_source.mjs";

/** @import { ServerConfig } from "../../types/server-runtime.d.ts" */
/** @typedef {{owner: string | null, deleted: boolean | number}} BoardLifecycle */
const lifecycleQueue = new SerialTaskQueue();
/** @type {Set<string>} */
const deletingBoards = new Set();

/** @param {string} value */
export function ownerDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} name @param {ServerConfig} config */
function key(name, config) {
  return path.join(config.HISTORY_DIR, `board-${name}.owner.json`);
}

/** @param {string} name @param {ServerConfig} config */
export function isProtectedBoard(name, config) {
  return (
    name === "anonymous" ||
    name === canonicalizeBoardName(config.DEFAULT_BOARD || "")
  );
}

/** @param {string} name @param {ServerConfig} config @returns {Promise<BoardLifecycle | null>} */
export async function readBoardLifecycle(name, config) {
  if (process.env.WBO_CLOUD_STORAGE_URL) {
    const response = await storageRequest(
      `/lifecycle/${encodeURIComponent(name)}`,
    );
    return /** @type {Promise<BoardLifecycle | null>} */ (response.json());
  }
  try {
    const value = JSON.parse(await readFile(key(name, config), "utf8"));
    if (
      !value ||
      (value.owner !== null &&
        (typeof value.owner !== "string" ||
          !/^[0-9a-f]{64}$/.test(value.owner))) ||
      typeof value.deleted !== "boolean"
    )
      throw new Error("Invalid board ownership record");
    return value;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}

/** @param {string} name @param {ServerConfig} config @param {BoardLifecycle} value */
async function writeLifecycle(name, config, value) {
  const file = key(name, config);
  await mkdir(config.HISTORY_DIR, { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, file);
}

/** @param {string} name @param {string} secret @param {ServerConfig} config */
export async function registerBoardCreator(name, secret, config) {
  return lifecycleQueue.runExclusive(async () => {
    const previous = await readBoardLifecycle(name, config);
    if (isBoardDeleting(name, config) || previous?.deleted)
      throw new BoundaryError(410, "board_deleted");
    if (previous || !secret) return;
    const mayClaim =
      !isProtectedBoard(name, config) &&
      !getLoadedBoard(name) &&
      !(await boardExists(name, config));
    const owner = ownerDigest(secret);
    if (process.env.WBO_CLOUD_STORAGE_URL) {
      const response = await storageRequest(
        `/lifecycle/${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner, mayClaim }),
        },
      );
      const record = await response.json();
      if (record.deleted) throw new BoundaryError(410, "board_deleted");
    } else {
      await writeLifecycle(name, config, {
        owner: mayClaim ? owner : null,
        deleted: false,
      });
    }
  });
}

/** @param {string} name @param {ServerConfig} config */
export async function assertBoardActive(name, config) {
  if (
    deletingBoards.has(key(name, config)) ||
    (await readBoardLifecycle(name, config))?.deleted
  ) {
    throw new BoundaryError(
      410,
      "board_deleted",
      "This board has been deleted.",
    );
  }
}

/** @param {string} name @param {ServerConfig} config */
export function isBoardDeleting(name, config) {
  return deletingBoards.has(key(name, config));
}

/** @param {unknown} candidate @param {ServerConfig} config */
export function validBoardAdminKey(candidate, config) {
  const expected = config.BOARD_ADMIN_KEY;
  return (
    typeof expected === "string" &&
    expected.length > 0 &&
    typeof candidate === "string" &&
    candidate.length <= 256 &&
    timingSafeEqual(
      Buffer.from(ownerDigest(expected), "hex"),
      Buffer.from(ownerDigest(candidate), "hex"),
    )
  );
}

/**
 * Freeze live clients and drain writes before committing the deletion fence.
 * A failed cleanup can be retried; tombstones reserve deleted board URLs.
 * @param {string} name @param {ServerConfig} config
 * @param {() => Promise<() => void>} freeze
 */
export async function eraseBoard(name, config, freeze) {
  return lifecycleQueue.runExclusive(async () => {
    deletingBoards.add(key(name, config));
    const finish = await freeze();
    if (process.env.WBO_CLOUD_STORAGE_URL) {
      await storageRequest(`/lifecycle/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    }
    const previous = await readBoardLifecycle(name, config);
    await writeLifecycle(name, config, {
      owner: previous?.owner || null,
      deleted: true,
    });
    const svgBase = path.basename(boardSvgPath(name, config.HISTORY_DIR));
    const jsonBase = path.basename(boardJsonPath(name, config.HISTORY_DIR));
    const files = await readdir(config.HISTORY_DIR);
    await Promise.all(
      files
        .filter(
          (file) =>
            file === svgBase ||
            file.startsWith(`${svgBase}.`) ||
            file === jsonBase ||
            file.startsWith(`${jsonBase}.`),
        )
        .map((file) =>
          rm(path.join(config.HISTORY_DIR, file), { force: true }),
        ),
    );
    finish();
    deletingBoards.delete(key(name, config));
  });
}
