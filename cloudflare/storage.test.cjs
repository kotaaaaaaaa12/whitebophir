const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, rm, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createServer } = require("node:http");
const { fork, spawn } = require("node:child_process");
const { once } = require("node:events");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");

async function createStorage(directory) {
  const built = await esbuild.build({
    stdin: {
      contents:
        'export { WhiteboardStorage } from "./cloudflare/storage.ts"; export default { fetch(r,e) { return e.STORAGE.getByName("boards-v1").fetch(r); } };',
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
  });
  return new Miniflare(
    convertV4MiniflareOptions({
      name: "storage-test",
      modules: true,
      script: built.outputFiles[0].text,
      compatibilityDate: "2026-10-01",
      durableObjects: {
        STORAGE: { className: "WhiteboardStorage", useSQLite: true },
      },
      r2Buckets: ["BOARDS"],
      resourcePersistencePath: directory,
      isolatedResourcePersistencePath: directory,
    }),
  );
}

async function commit(storage, name, entries) {
  return storage.dispatchFetch(`http://wbo.storage/journal/${name}`, {
    method: "POST",
    body: JSON.stringify(entries),
  });
}

async function snapshot(storage, name, seq, svg) {
  return storage.dispatchFetch(
    `http://wbo.storage/snapshot/${name}?seq=${seq}`,
    {
      method: "PUT",
      body: svg,
      headers: { "content-length": String(Buffer.byteLength(svg)) },
    },
  );
}

function connectSocket(port, baselineSeq) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket&board=persist-test&baselineSeq=${baselineSeq}`,
  );
  const frames = [];
  const waiters = new Set();
  function waitFor(predicate) {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Socket frame timed out"));
      }, 5000);
      waiter.resolve = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      waiters.add(waiter);
    });
  }
  socket.addEventListener("message", (event) => {
    const packet = String(event.data);
    if (packet.startsWith("0")) socket.send("40");
    if (packet === "2") socket.send("3");
    if (!packet.startsWith("42")) return;
    const frame = JSON.parse(packet.slice(2));
    frames.push(frame);
    for (const waiter of waiters) {
      if (waiter.predicate(frame)) {
        waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  });
  return {
    ready: waitFor((frame) => frame[0] === "broadcast" && frame[1].type === 5),
    deleted: () => waitFor((frame) => frame[0] === "board_deleted"),
    seq: (seq) =>
      waitFor(
        (frame) =>
          frame[0] === "broadcast" && frame[1].seq === seq && frame[1].mutation,
      ),
    send: (mutation) =>
      socket.send(`42${JSON.stringify(["broadcast", mutation])}`),
  };
}

test("journal validation, snapshot compaction, and persistence across runtime restarts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wbo-storage-"));
  let storage = await createStorage(dir);
  try {
    const entry = {
      seq: 1,
      acceptedAtMs: 100,
      mutation: { tool: "rectangle", type: 1, id: "r1" },
    };
    assert.equal((await commit(storage, "test", [entry])).status, 204);
    assert.equal((await commit(storage, "test", [entry])).status, 204);
    assert.equal(
      (await commit(storage, "test", [{ ...entry, mutation: { type: 6 } }]))
        .status,
      409,
    );
    assert.equal(
      (await commit(storage, "test", [{ ...entry, seq: 3 }])).status,
      409,
    );
    assert.equal((await commit(storage, "test", [null])).status, 400);
    assert.equal((await commit(storage, "..%2Ftest", [entry])).status, 400);
    const svg = '<svg data-wbo-seq="1"></svg>';
    assert.equal((await snapshot(storage, "test", 1, svg)).status, 204);
    assert.deepEqual(
      await (
        await storage.dispatchFetch("http://wbo.storage/journal/test")
      ).json(),
      [],
    );
    assert.equal((await snapshot(storage, "test", 0, "stale")).status, 409);
    assert.equal(
      (await commit(storage, "test", [{ ...entry, seq: 2 }])).status,
      204,
    );
    // An unreferenced object models a crash after R2 upload but before the
    // SQLite checkpoint update. Recovery must still select the old snapshot.
    const bucket = await storage.getR2Bucket("BOARDS");
    await bucket.put("boards/test/2.svg", "uncommitted", {
      customMetadata: { seq: "2" },
    });
    await storage.dispose();
    storage = await createStorage(dir);
    const restored = await storage.dispatchFetch(
      "http://wbo.storage/restore/test",
    );
    assert.equal(restored.headers.get("x-snapshot-seq"), "1");
    assert.equal(await restored.text(), svg);
    const log = await (
      await storage.dispatchFetch("http://wbo.storage/journal/test?after=1")
    ).json();
    assert.equal(log.length, 1);
    assert.equal(log[0].seq, 2);
    assert.deepEqual(
      await (await storage.dispatchFetch("http://wbo.storage/boards")).json(),
      ["test"],
    );
  } finally {
    await storage.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ownership persists and deletion removes checkpoints, orphaned snapshots and journals without resurrection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wbo-storage-delete-"));
  let storage = await createStorage(dir);
  try {
    const owner = "a".repeat(64);
    const register = async (value) =>
      (
        await storage.dispatchFetch("http://wbo.storage/lifecycle/owned", {
          method: "POST",
          body: JSON.stringify({ owner: value, mayClaim: true }),
        })
      ).json();
    assert.equal((await register(owner)).owner, owner);
    assert.equal((await register("b".repeat(64))).owner, owner);
    await storage.dispose();
    storage = await createStorage(dir);
    assert.equal(
      (
        await (
          await storage.dispatchFetch("http://wbo.storage/lifecycle/owned")
        ).json()
      ).owner,
      owner,
    );
    const entry = {
      seq: 1,
      acceptedAtMs: 100,
      mutation: { tool: "rectangle", type: 1, id: "r1" },
    };
    assert.equal((await commit(storage, "owned", [entry])).status, 204);
    assert.equal(
      (await snapshot(storage, "owned", 1, '<svg data-wbo-seq="1"></svg>'))
        .status,
      204,
    );
    assert.equal(
      (await commit(storage, "owned", [{ ...entry, seq: 2 }])).status,
      204,
    );
    const bucket = await storage.getR2Bucket("BOARDS");
    await bucket.put("boards/owned/99.svg", "orphaned upload");
    await bucket.put("boards/other/0.svg", "keep another board");
    // A journal body that finishes after deletion must not recreate catalog rows.
    let finishBody;
    const delayedBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        finishBody = () => {
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({ ...entry, seq: 3 })}]`,
            ),
          );
          controller.close();
        };
      },
    });
    const delayedJournal = storage.dispatchFetch(
      "http://wbo.storage/journal/owned",
      { method: "POST", body: delayedBody, duplex: "half" },
    );
    const removed = await storage.dispatchFetch(
      "http://wbo.storage/lifecycle/owned",
      { method: "DELETE" },
    );
    assert.equal(removed.status, 204);
    finishBody();
    assert.equal((await delayedJournal).status, 410);
    assert.equal(
      (await bucket.list({ prefix: "boards/owned/" })).objects.length,
      0,
    );
    assert.ok(await bucket.get("boards/other/0.svg"));
    assert.equal(
      (await commit(storage, "owned", [{ ...entry, seq: 3 }])).status,
      410,
    );
    assert.equal(
      (await snapshot(storage, "owned", 2, "late snapshot")).status,
      410,
    );
    await storage.dispose();
    storage = await createStorage(dir);
    assert.deepEqual(
      await (await storage.dispatchFetch("http://wbo.storage/boards")).json(),
      [],
    );
    assert.equal(
      (await storage.dispatchFetch("http://wbo.storage/restore/owned")).status,
      410,
    );
    assert.equal(
      (await storage.dispatchFetch("http://wbo.storage/journal/owned")).status,
      410,
    );
    assert.equal((await register("b".repeat(64))).deleted, 1);
  } finally {
    await storage.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepted edits survive an abrupt Node process exit and two empty-disk starts", {
  timeout: 60_000,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wbo-recovery-"));
  const storage = await createStorage(dir);
  const bridge = createServer(async (request, response) => {
    try {
      const parts = [];
      for await (const part of request) parts.push(part);
      const result = await storage.dispatchFetch(
        `http://wbo.storage${request.url}`,
        {
          method: request.method,
          headers: request.headers,
          ...(request.method !== "GET" ? { body: Buffer.concat(parts) } : {}),
        },
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  bridge.listen(0, "127.0.0.1");
  await once(bridge, "listening");
  const baseEnv = {
    ...process.env,
    WBO_SILENT: "true",
    HOST: "127.0.0.1",
    PORT: "0",
    WBO_SAVE_INTERVAL: "1000000000",
    WBO_MAX_SAVE_DELAY: "1000000000",
    WBO_CLOUD_STORAGE_URL: `http://127.0.0.1:${bridge.address().port}`,
    WBO_BOARD_ADMIN_KEY: "recovery-test-admin-key",
  };
  let child;
  try {
    const script = `
      import { BoardData } from './server/board/data.mjs';
      import { createBoardSession } from './server/board/session.mjs';
      import * as config from './server/configuration.mjs';
      const b = new BoardData('persist-test', config);
      const s = createBoardSession(b);
      const edits = [
        {tool:'rectangle',type:1,id:'r1',color:'#123456',size:4,opacity:1,x:10,y:20,x2:60,y2:70},
        {tool:'pencil',type:1,id:'l1',color:'#000000',size:3,opacity:1,x:5,y:5},
        {tool:'pencil',type:4,parent:'l1',x:10,y:10},
        {tool:'text',type:1,id:'t1',color:'#112233',size:24,opacity:1,x:80,y:90},
        {tool:'text',type:2,id:'t1',txt:'Saved after a crash'},
        {tool:'hand',type:7,id:'r1',newid:'r2'},
        {tool:'eraser',type:3,id:'r1'},
      ];
      for(const m of edits) {
        const r = await s.acceptPersistentMutation(m);
        if(!r.ok) throw new Error(r.reason);
      }
      process.exit(0);
    `;
    const writer = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: root,
        env: { ...baseEnv, WBO_HISTORY_DIR: path.join(dir, "lost-disk") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let errorOutput = "";
    writer.stderr.on("data", (data) => {
      errorOutput += data;
    });
    const [code] = await once(writer, "exit");
    assert.equal(code, 0, errorOutput);
    for (let attempt = 0; attempt < 2; attempt++) {
      const history = path.join(dir, `fresh-${attempt}`);
      child = fork(path.join(root, "cloudflare/entrypoint.mjs"), [], {
        cwd: root,
        env: { ...baseEnv, WBO_HISTORY_DIR: history },
        silent: true,
      });
      let errors = "";
      child.stderr.on("data", (data) => {
        errors += data;
      });
      const started = await Promise.race([
        once(child, "message").then(([message]) => message),
        once(child, "exit").then(([exitCode]) => {
          throw new Error(`Recovery exited ${exitCode}: ${errors}`);
        }),
      ]);
      assert.equal(started.type, "server-started");
      const svg = await readFile(
        path.join(history, "board-persist-test.svg"),
        "utf8",
      );
      assert.match(
        svg,
        attempt === 0 ? /Saved after a crash/ : /Saved through Socket.IO/,
      );
      assert.match(svg, /id="r2"/);
      assert.match(svg, /id="l1"/);
      assert.doesNotMatch(svg, /id="r1"/);
      assert.match(
        svg,
        attempt === 0 ? /data-wbo-seq="7"/ : /data-wbo-seq="9"/,
      );
      const page = await fetch(
        `http://127.0.0.1:${started.port}/boards/persist-test`,
      );
      assert.equal(page.status, 200);
      assert.match(
        await page.text(),
        attempt === 0 ? /Saved after a crash/ : /Saved through Socket.IO/,
      );
      if (attempt === 0) {
        const first = connectSocket(started.port, 7);
        const second = connectSocket(started.port, 7);
        await Promise.all([first.ready, second.ready]);
        first.send({
          tool: 1,
          type: 4,
          parent: "l1",
          x: 30,
          y: 40,
          clientMutationId: "cm-test-8",
        });
        await Promise.all([first.seq(8), second.seq(8)]);
        first.send({
          tool: 5,
          type: 2,
          id: "t1",
          txt: "Saved through Socket.IO",
          clientMutationId: "cm-test-9",
        });
        await Promise.all([first.seq(9), second.seq(9)]);
        const persisted = await (
          await storage.dispatchFetch(
            "http://wbo.storage/journal/persist-test?after=7",
          )
        ).json();
        assert.equal(persisted.at(-1).seq, 9);
        // Keep clients connected while killing the process, so unload does not
        // save the SVG. The next start must replay a journal over a snapshot.
      } else {
        const first = connectSocket(started.port, 9);
        const second = connectSocket(started.port, 9);
        await Promise.all([first.ready, second.ready]);
        const notifications = [first.deleted(), second.deleted()];
        const removed = await fetch(
          `http://127.0.0.1:${started.port}/api/boards/persist-test`,
          {
            method: "DELETE",
            headers: {
              "x-wbo-delete": "1",
              "x-board-admin-key": baseEnv.WBO_BOARD_ADMIN_KEY,
            },
          },
        );
        assert.equal(removed.status, 204);
        await Promise.all(notifications);
        assert.deepEqual(
          await (
            await storage.dispatchFetch("http://wbo.storage/boards")
          ).json(),
          [],
        );
        const bucket = await storage.getR2Bucket("BOARDS");
        assert.equal(
          (await bucket.list({ prefix: "boards/persist-test/" })).objects
            .length,
          0,
        );
        const gone = await fetch(
          `http://127.0.0.1:${started.port}/boards/persist-test`,
        );
        assert.equal(gone.status, 410);
        await gone.text();
      }
      child.kill("SIGKILL");
      await once(child, "exit");
      child = undefined;
    }
    child = fork(path.join(root, "cloudflare/entrypoint.mjs"), [], {
      cwd: root,
      env: { ...baseEnv, WBO_HISTORY_DIR: path.join(dir, "after-delete") },
      silent: true,
    });
    let restartErrors = "";
    child.stderr.on("data", (data) => {
      restartErrors += data;
    });
    const restarted = await Promise.race([
      once(child, "message").then(([message]) => message),
      once(child, "exit").then(([code]) => {
        throw new Error(`Restart exited ${code}: ${restartErrors}`);
      }),
    ]);
    const gone = await fetch(
      `http://127.0.0.1:${restarted.port}/boards/persist-test`,
    );
    assert.equal(gone.status, 410);
    await gone.text();
    child.kill("SIGKILL");
    await once(child, "exit");
    child = undefined;
  } finally {
    if (child) child.kill("SIGKILL");
    bridge.closeAllConnections();
    await new Promise((resolve) => bridge.close(resolve));
    await storage.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
