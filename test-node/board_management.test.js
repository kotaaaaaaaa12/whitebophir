const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  createConfig,
  closeServer,
  getTcpAddress,
  createSocketScenario,
} = require("./test_helpers.js");

test("HTTP deletion verifies creator cookies, confirms intent, protects public boards and removes saved files", async () => {
  const { createServerApp } = await import("../server/server.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-delete-http-"));
  const config = createConfig({
    PORT: 0,
    HOST: "127.0.0.1",
    HISTORY_DIR: dir,
    AUTH_SECRET_KEY: "",
    BOARD_ADMIN_KEY: "admin-key-for-this-test",
  });
  const app = await createServerApp(config, { logStarted: false });
  const base = `http://127.0.0.1:${getTcpAddress(app).port}`;
  try {
    const created = await fetch(`${base}/boards/owned`);
    assert.equal(created.status, 200);
    const cookie = created.headers.get("set-cookie")?.split(";")[0] || "";
    assert.match(cookie, /^wbo-user-secret-v1=[0-9a-f]{32}$/);
    await created.text();
    const access = await fetch(`${base}/api/boards/owned`, {
      headers: { cookie },
    });
    assert.equal(access.headers.get("cache-control"), "private, no-store");
    assert.equal((await access.json()).canDelete, true);
    const stranger = await fetch(`${base}/boards/owned`);
    const otherCookie = stranger.headers.get("set-cookie")?.split(";")[0] || "";
    await stranger.text();
    assert.equal(
      (
        await (
          await fetch(`${base}/api/boards/owned`, {
            headers: { cookie: otherCookie },
          })
        ).json()
      ).canDelete,
      false,
    );
    const rejectedHeaders = /** @type {Record<string, string>[]} */ ([
      { cookie },
      { cookie: otherCookie, "x-wbo-delete": "1" },
      { cookie, "x-wbo-delete": "1", "sec-fetch-site": "cross-site" },
    ]);
    for (const headers of rejectedHeaders) {
      const denied = await fetch(`${base}/api/boards/owned`, {
        method: "DELETE",
        headers,
      });
      assert.equal(denied.status, 403);
      await denied.text();
    }
    for (const suffix of [
      ".svg",
      ".svg.bak",
      ".svg.123.quarantine",
      ".json",
      ".json.bak",
    ]) {
      await fs.writeFile(
        path.join(dir, `board-owned${suffix}`),
        "private drawing content",
      );
    }
    await fs.writeFile(
      path.join(dir, "board-owned-other.svg"),
      "keep this board",
    );
    const deleted = await fetch(`${base}/api/boards/owned`, {
      method: "DELETE",
      headers: { cookie, "x-wbo-delete": "1" },
    });
    assert.equal(deleted.status, 204);
    assert.deepEqual(
      (await fs.readdir(dir))
        .filter((file) => file.startsWith("board-owned."))
        .sort(),
      ["board-owned.owner.json"],
    );
    assert.equal(
      await fs.readFile(path.join(dir, "board-owned-other.svg"), "utf8"),
      "keep this board",
    );
    for (const route of [
      "boards/owned",
      "boards/owned.svg",
      "download/owned",
      "preview/owned",
    ]) {
      const gone = await fetch(`${base}/${route}`, { headers: { cookie } });
      assert.equal(gone.status, 410, route);
      await gone.text();
    }
    // Older boards never become owned by their first visitor after the update.
    await fs.writeFile(
      path.join(dir, "board-legacy.svg"),
      '<svg id="canvas"><g id="drawingArea"></g></svg>',
    );
    const legacy = await fetch(`${base}/boards/legacy`, {
      headers: { cookie },
    });
    assert.equal(legacy.status, 200);
    await legacy.text();
    assert.equal(
      (
        await (
          await fetch(`${base}/api/boards/legacy`, { headers: { cookie } })
        ).json()
      ).canDelete,
      false,
    );
    const badKey = await fetch(`${base}/api/boards/legacy`, {
      method: "DELETE",
      headers: { "x-wbo-delete": "1", "x-board-admin-key": "incorrect" },
    });
    assert.equal(badKey.status, 403);
    await badKey.text();
    const adminDelete = await fetch(`${base}/api/boards/legacy`, {
      method: "DELETE",
      headers: {
        "x-wbo-delete": "1",
        "x-board-admin-key": config.BOARD_ADMIN_KEY,
      },
    });
    assert.equal(adminDelete.status, 204);
    const publicDelete = await fetch(`${base}/api/boards/anonymous`, {
      method: "DELETE",
      headers: {
        cookie,
        "x-wbo-delete": "1",
        "x-board-admin-key": config.BOARD_ADMIN_KEY,
      },
    });
    assert.equal(publicDelete.status, 403);
    await publicDelete.text();
    const method = await fetch(`${base}/api/boards/unused`, { method: "POST" });
    assert.equal(method.status, 405);
    await method.text();
  } finally {
    await closeServer(app);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("deleting a live board closes all participants and rejects later writes and reconnections", async () => {
  await createSocketScenario({ boardName: "live-delete" }, async (scenario) => {
    const first = await scenario.connect();
    const second = await scenario.connect({ id: "second" });
    const { eraseBoard } = await import(
      "../server/persistence/board_lifecycle.mjs"
    );
    const { getBoardSession } = await import("../server/board/session.mjs");
    const board = await scenario.getLoadedBoard("live-delete");
    const session = getBoardSession(board);
    await eraseBoard("live-delete", scenario.sockets.__config, () =>
      scenario.sockets.freezeBoardForDeletion("live-delete"),
    );
    for (const client of [first, second]) {
      assert.ok(
        client.emitted.some(
          (event) =>
            event.event === "board_deleted" &&
            event.payload.boardName === "live-delete",
        ),
      );
      assert.equal(client.socket.disconnected, true);
    }
    assert.equal(scenario.getLoadedBoard("live-delete"), undefined);
    assert.equal(board.disposed, true);
    assert.deepEqual(
      await session.acceptPersistentMutation({
        tool: 3,
        type: 1,
        id: "late",
        color: "#000000",
        size: 10,
        x: 0,
        y: 0,
        x2: 10,
        y2: 10,
      }),
      { ok: false, reason: "board_deleted" },
    );
    const reconnect = await scenario.connect({ id: "reconnect" });
    assert.equal(reconnect.socket.disconnected, true);
    assert.equal(scenario.getLoadedBoard("live-delete"), undefined);
  });
});
