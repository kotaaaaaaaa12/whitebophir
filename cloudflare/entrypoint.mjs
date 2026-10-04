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
import { replayEntry } from "./recovery.mjs";

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
    const skipped = [];
    for (;;) {
      const log = await storageRequest(`/journal/${encoded}?after=${afterSeq}`);
      const entries = await log.json();
      if (!Array.isArray(entries)) throw new Error("Invalid mutation journal");
      if (entries.length === 0) break;
      for (const entry of entries) {
        if (await replayEntry(board, entry)) skipped.push(entry.seq);
        afterSeq = entry.seq;
      }
    }
    if (board.getSeq() !== snapshotSeq) {
      if (skipped.length) {
        // Archive the original snapshot reference and the entire pending log
        // before a successful save can compact any recovery input.
        await storageRequest(`/recovery/${encoded}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkpoint: snapshotSeq,
            through: afterSeq,
            skipped,
          }),
        });
        console.warn(
          JSON.stringify({
            event: "whiteboard.recovery.archived_orphan_points",
            board: name,
            checkpoint: snapshotSeq,
            through: afterSeq,
            count: skipped.length,
            first: skipped[0],
          }),
        );
      }
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
