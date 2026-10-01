const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, rm, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createServer } = require("node:http");
const { fork, spawn } = require("node:child_process");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");

async function createStorage(directory) {
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { WhiteboardStorage as Storage } from "./cloudflare/storage.ts";
        // Test-only handshake: delete only after boundedJson begins reading.
        // Otherwise an early 410 can close an unfinished HTTP upload (EPIPE)
        // before this test reaches the intended post-admission deletion race.
        export class WhiteboardStorage extends Storage {
          signalBodyStarted = () => {};
          bodyStarted = new Promise(resolve => { this.signalBodyStarted = resolve; });
          async fetch(request) {
            if (new URL(request.url).pathname === "/__test/body-started") {
              await this.bodyStarted;
              return new Response(null, {status: 204});
            }
            if (request.headers.get("x-test-delayed-body") === "1") {
              const body = request.body.pipeThrough(new TransformStream({
                transform: (chunk, controller) => {
                  this.signalBodyStarted();
                  controller.enqueue(chunk);
                }
              }));
              request = new Request(request, {body});
            }
            return super.fetch(request);
          }
        }
        export default { fetch(r,e) { return e.STORAGE.getByName("boards-v1").fetch(r); } };
      `,
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
  let ackId = 0;
  const acknowledgments = new Map();
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
    if (packet.startsWith("43")) {
      const match = /^43(\d+)(\[.*)$/.exec(packet);
      if (match)
        acknowledgments.get(Number(match[1]))?.(JSON.parse(match[2])[0]);
      return;
    }
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
    call: (event, payload) =>
      new Promise((resolve, reject) => {
        const id = ++ackId;
        const timer = setTimeout(() => {
          acknowledgments.delete(id);
          reject(new Error("Chat ack timed out"));
        }, 5000);
        acknowledgments.set(id, (result) => {
          clearTimeout(timer);
          acknowledgments.delete(id);
          resolve(result);
        });
        socket.send(`42${id}${JSON.stringify([event, payload])}`);
      }),
    chat: () => waitFor((frame) => frame[0] === "chat_message"),
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
      {
        method: "POST",
        body: delayedBody,
        duplex: "half",
        headers: { "x-test-delayed-body": "1" },
      },
    );
    await storage.dispatchFetch("http://wbo.storage/__test/body-started", {
      signal: AbortSignal.timeout(5000),
    });
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

test("private catalog includes empty lifecycle records, saved boards, search and pagination, excludes tombstones, and survives a storage restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wbo-storage-catalog-"));
  let storage = await createStorage(dir);
  try {
    for (let index = 0; index < 102; index++) {
      const response = await storage.dispatchFetch(
        `http://wbo.storage/lifecycle/private-${String(index).padStart(3, "0")}`,
        {
          method: "POST",
          body: JSON.stringify({ owner: "a".repeat(64), mayClaim: true }),
        },
      );
      assert.equal(response.status, 200);
      await response.text();
    }
    const entry = {
      seq: 1,
      acceptedAtMs: Date.now(),
      mutation: {
        tool: 2,
        type: 1,
        id: "saved-item",
        x: 1,
        y: 2,
        x2: 3,
        y2: 4,
        color: "#000000",
        size: 2,
      },
    };
    assert.equal((await commit(storage, "saved-legacy", [entry])).status, 204);
    assert.equal(
      (
        await storage.dispatchFetch(
          "http://wbo.storage/lifecycle/private-050",
          { method: "DELETE" },
        )
      ).status,
      204,
    );
    const first = await (
      await storage.dispatchFetch("http://wbo.storage/catalog")
    ).json();
    assert.equal(first.names.length, 100);
    assert.equal(first.names.includes("private-050"), false);
    assert.equal(first.nextCursor, "private-100");
    const second = await (
      await storage.dispatchFetch(
        `http://wbo.storage/catalog?after=${first.nextCursor}`,
      )
    ).json();
    assert.deepEqual(second, {
      names: ["private-101", "saved-legacy"],
      nextCursor: null,
    });
    const search = await (
      await storage.dispatchFetch("http://wbo.storage/catalog?q=PRIVATE-10")
    ).json();
    assert.deepEqual(search.names, ["private-100", "private-101"]);
    assert.deepEqual(
      (
        await (
          await storage.dispatchFetch("http://wbo.storage/catalog?q=%25")
        ).json()
      ).names,
      [],
    );
    await storage.dispose();
    storage = await createStorage(dir);
    const restored = await (
      await storage.dispatchFetch("http://wbo.storage/catalog?q=saved")
    ).json();
    assert.deepEqual(restored.names, ["saved-legacy"]);
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
        const sent = await first.call("chat_send", {
          clientId: randomUUID(),
          text: "Chat survives an empty Container disk",
        });
        assert.equal(sent.ok, true);
        assert.equal((await second.chat())[1].id, sent.message.id);
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
        const history = await first.call("chat_history", {});
        assert.equal(history.ok, true);
        assert.equal(
          history.messages[0].text,
          "Chat survives an empty Container disk",
        );
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
        assert.equal(
          (await storage.dispatchFetch("http://wbo.storage/chat/persist-test"))
            .status,
          410,
        );
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

test("chat history survives storage restarts, isolates boards, paginates without loss, deduplicates retries and fences delayed deletion writes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wbo-chat-storage-"));
  let storage = await createStorage(dir);
  const input = (text) => ({
    author: "a".repeat(64),
    clientId: randomUUID(),
    name: "こた",
    text,
    sentAt: Date.now(),
  });
  const post = (board, value) =>
    storage.dispatchFetch(`http://wbo.storage/chat/${board}`, {
      method: "POST",
      body: JSON.stringify(value),
    });
  const get = async (suffix) =>
    (await storage.dispatchFetch(`http://wbo.storage/chat/${suffix}`)).json();
  try {
    const firstInput = input("message 0");
    const first = await (await post("chat-a", firstInput)).json();
    assert.deepEqual(Object.keys(first).sort(), [
      "id",
      "name",
      "sentAt",
      "text",
    ]);
    for (let i = 1; i < 103; i++)
      assert.equal((await post("chat-a", input(`message ${i}`))).status, 200);
    assert.deepEqual(
      await (
        await post("chat-a", { ...firstInput, text: "retry changed" })
      ).json(),
      first,
    );
    assert.equal((await post("chat-b", input("another board"))).status, 200);
    assert.equal(
      (await post("chat-a", { ...firstInput, text: "\u0000" })).status,
      400,
    );
    assert.equal(
      (
        await storage.dispatchFetch(
          "http://wbo.storage/chat/chat-a?before=nope",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await storage.dispatchFetch("http://wbo.storage/chat/chat-a", {
          method: "POST",
          body: " ".repeat(16385),
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("chat-a", { ...firstInput, text: null })).status,
      400,
    );
    await storage.dispose();
    storage = await createStorage(dir);
    const recent = await get("chat-a");
    const older = await get(`chat-a?before=${recent.nextBefore}`);
    const oldest = await get(`chat-a?before=${older.nextBefore}`);
    assert.deepEqual(
      [recent.messages.length, older.messages.length, oldest.messages.length],
      [50, 50, 3],
    );
    assert.equal(oldest.nextBefore, null);
    assert.equal(
      new Set(
        [...oldest.messages, ...older.messages, ...recent.messages].map(
          (m) => m.id,
        ),
      ).size,
      103,
    );
    assert.equal(recent.messages.at(-1).text, "message 102");
    assert.equal(oldest.messages[0].text, "message 0");
    assert.equal((await get("chat-b")).messages[0].text, "another board");
    assert.deepEqual(
      (await (await storage.dispatchFetch("http://wbo.storage/catalog")).json())
        .names,
      ["chat-a", "chat-b"],
    );
    let finishBody;
    const delayedBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        finishBody = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify(input("late message")).slice(1),
            ),
          );
          controller.close();
        };
      },
    });
    const delayed = storage.dispatchFetch("http://wbo.storage/chat/chat-a", {
      method: "POST",
      body: delayedBody,
      duplex: "half",
      headers: { "x-test-delayed-body": "1" },
    });
    await storage.dispatchFetch("http://wbo.storage/__test/body-started", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      (
        await storage.dispatchFetch("http://wbo.storage/lifecycle/chat-a", {
          method: "DELETE",
        })
      ).status,
      204,
    );
    finishBody();
    assert.equal((await delayed).status, 410);
    assert.equal((await post("chat-a", input("deleted"))).status, 410);
    assert.equal(
      (await storage.dispatchFetch("http://wbo.storage/chat/chat-a")).status,
      410,
    );
    assert.equal((await get("chat-b")).messages.length, 1);
    await storage.dispose();
    storage = await createStorage(dir);
    assert.equal(
      (await storage.dispatchFetch("http://wbo.storage/chat/chat-a")).status,
      410,
    );
  } finally {
    await storage.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("chat message deletion survives restart, removes content, is scoped by board and prevents delayed retries from resurrecting it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wbo-chat-delete-"));
  let storage = await createStorage(dir);
  const input = {
    author: "a".repeat(64),
    clientId: randomUUID(),
    name: "Peer",
    text: "remove this body",
    sentAt: Date.now(),
  };
  const post = (board, value) =>
    storage.dispatchFetch(`http://wbo.storage/chat/${board}`, {
      method: "POST",
      body: JSON.stringify(value),
    });
  const remove = (board, id) =>
    storage.dispatchFetch(`http://wbo.storage/chat/${board}?id=${id}`, {
      method: "DELETE",
    });
  try {
    const message = await (await post("chat-delete-a", input)).json();
    const other = await (
      await post("chat-delete-b", { ...input, text: "keep" })
    ).json();
    assert.equal(await (await remove("chat-delete-a", other.id)).json(), false);
    assert.equal((await remove("chat-delete-a", "bad")).status, 400);
    let finish;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        finish = () => {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(input).slice(1)),
          );
          controller.close();
        };
      },
    });
    const delayed = storage.dispatchFetch(
      "http://wbo.storage/chat/chat-delete-a",
      {
        method: "POST",
        body,
        duplex: "half",
        headers: { "x-test-delayed-body": "1" },
      },
    );
    await storage.dispatchFetch("http://wbo.storage/__test/body-started", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      await (await remove("chat-delete-a", message.id)).json(),
      true,
    );
    finish();
    assert.equal((await delayed).status, 409);
    assert.equal(
      await (await remove("chat-delete-a", message.id)).json(),
      true,
    );
    await storage.dispose();
    storage = await createStorage(dir);
    assert.equal((await post("chat-delete-a", input)).status, 409);
    assert.equal(
      (
        await (
          await storage.dispatchFetch("http://wbo.storage/chat/chat-delete-a")
        ).json()
      ).messages.length,
      0,
    );
    assert.equal(
      (
        await (
          await storage.dispatchFetch("http://wbo.storage/chat/chat-delete-b")
        ).json()
      ).messages[0].text,
      "keep",
    );
    assert.equal(
      (
        await storage.dispatchFetch(
          "http://wbo.storage/lifecycle/chat-delete-a",
          { method: "DELETE" },
        )
      ).status,
      204,
    );
    assert.equal((await remove("chat-delete-a", message.id)).status, 410);
  } finally {
    await storage.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
