import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const storageUrl = process.env.WBO_CLOUD_STORAGE_URL || "";

/** @param {string} path @param {RequestInit} [init] */
export async function storageRequest(path, init) {
  const response = await fetch(`${storageUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Persistent storage returned HTTP ${response.status}`);
  }
  return response;
}

/**
 * Stop immediately if persistence fails. Continuing with uncommitted state
 * would let clients observe a board that cannot be recovered after a restart.
 * @param {unknown} error
 * @returns {never}
 */
function persistenceFailure(error) {
  console.error("cloud.persistence_failed", error);
  process.exit(1);
}

/**
 * @param {string} board
 * @param {import("../../types/server-runtime.d.ts").MutationLogEntry[]} entries
 */
export async function commitCloudMutations(board, entries) {
  if (!storageUrl || entries.length === 0) return;
  try {
    await storageRequest(`/journal/${encodeURIComponent(board)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entries),
    });
  } catch (error) {
    persistenceFailure(error);
  }
}

/** @param {string} board @param {string} file @param {number} seq */
export async function publishCloudSnapshot(board, file, seq) {
  if (!storageUrl) return;
  try {
    const { size } = await stat(file);
    const input = createReadStream(file);
    const iterator = input[Symbol.asyncIterator]();
    const body = new ReadableStream({
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        input.destroy();
      },
    });
    await storageRequest(`/snapshot/${encodeURIComponent(board)}?seq=${seq}`, {
      method: "PUT",
      headers: {
        "content-type": "image/svg+xml",
        "content-length": String(size),
      },
      body,
      // Node.js requires duplex for a streaming request body.
      ...{ duplex: "half" },
    });
  } catch (error) {
    persistenceFailure(error);
  }
}
