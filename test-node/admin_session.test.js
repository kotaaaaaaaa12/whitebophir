const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createConfig,
  closeServer,
  getTcpAddress,
  createSocket,
} = require("./test_helpers.js");

test("administrator sessions bind identity, signature, expiry and live revocation across HTTP/socket capabilities", async () => {
  const auth = await import("../server/auth/admin_session.mjs");
  const { BoardPermissions } = await import(
    "../server/auth/board_capabilities.mjs"
  );
  const { boardStateForSocket } = await import("../server/socket/policy.mjs");
  const secret = "1234567890abcdef1234567890abcdef";
  const config = createConfig({
    BOARD_ADMIN_KEY: "private-admin-test-key",
    AUTH_SECRET_KEY: "jwt-is-required",
  });
  const token = auth.createAdminSession(secret, config);
  const board = { name: "any-board", readonly: true, isReadOnly: () => true };
  const permissions = BoardPermissions.forBoard({
    config,
    boardName: board.name,
    userInfo: { userSecret: secret, adminSession: token },
  });
  assert.deepEqual(permissions.resolveCapabilities(board), {
    canOpen: true,
    canEdit: true,
    canClear: true,
  });
  assert.equal(permissions.canGrantTemporaryModerator(), false);
  for (const [value, identity, settings] of [
    [token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), secret, config],
    [token, "abcdefabcdefabcdefabcdefabcdefab", config],
    [token, secret, { BOARD_ADMIN_KEY: "rotated" }],
    [token, secret, { BOARD_ADMIN_KEY: "" }],
    [
      auth.createAdminSession(secret, config, Date.now() - 8 * 86400000),
      secret,
      config,
    ],
    ["malformed", secret, config],
  ])
    assert.equal(auth.adminSessionExpiry(value, identity, settings)(), null);
  const { socket } = createSocket({
    query: { board: board.name },
    headers: {
      cookie: `wbo-user-secret-v1=${secret}; ${auth.ADMIN_COOKIE_NAME}=${token}`,
    },
  });
  const appSocket =
    /** @type {import("../types/server-runtime.d.ts").AppSocket} */ (
      /** @type {unknown} */ (socket)
    );
  assert.equal(boardStateForSocket(config, board, appSocket).canClear, true);
  auth.revokeAdminSession(token);
  assert.equal(permissions.canOpen(), false);
  assert.equal(permissions.resolveCapabilities(board).canClear, false);
  assert.equal(boardStateForSocket(config, board, appSocket).canClear, false);
});

test("administrator HTTP login protects credentials, allows non-owner deletion and revokes cookies on logout", async () => {
  const { createServerApp } = await import("../server/server.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-admin-http-"));
  const config = createConfig({
    PORT: 0,
    HOST: "127.0.0.1",
    BASE_PATH: "/wbo",
    HISTORY_DIR: dir,
    AUTH_SECRET_KEY: "",
    BOARD_ADMIN_KEY: "admin-test-password",
  });
  const app = await createServerApp(config, { logStarted: false });
  const base = `http://127.0.0.1:${getTcpAddress(app).port}`;
  try {
    const page = await fetch(`${base}/boards/login`);
    const cookie = (page.headers.get("set-cookie") || "").split(";")[0] || "";
    assert.match(page.headers.get("vary") || "", /Cookie/);
    assert.equal((await page.text()).includes(config.BOARD_ADMIN_KEY), false);
    const headers = {
      cookie,
      "content-type": "application/json",
      "x-wbo-admin": "1",
    };
    /** @param {Record<string, string>} extra @param {string} body */
    const login = (extra, body) =>
      fetch(`${base}/api/admin`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body,
      });
    /** @type {[Record<string, string>, string, number][]} */
    const rejected = [
      [
        { "x-wbo-admin": "" },
        JSON.stringify({ password: config.BOARD_ADMIN_KEY }),
        403,
      ],
      [
        { "sec-fetch-site": "cross-site" },
        JSON.stringify({ password: config.BOARD_ADMIN_KEY }),
        403,
      ],
      [{}, JSON.stringify({ password: "wrong" }), 403],
      [{}, "{", 400],
      [{}, "x".repeat(4097), 413],
    ];
    for (const [extra, body, status] of rejected) {
      const result = await login(extra, body);
      assert.equal(result.status, status);
      await result.text();
    }
    const signedIn = await login(
      {},
      JSON.stringify({ password: config.BOARD_ADMIN_KEY }),
    );
    assert.equal(signedIn.status, 200);
    const sessionCookie = signedIn.headers.get("set-cookie") || "";
    assert.match(sessionCookie, /HttpOnly; SameSite=Strict/);
    assert.match(sessionCookie, /Path=\/wbo\//);
    assert.equal(sessionCookie.includes(config.BOARD_ADMIN_KEY), false);
    const adminCookie = `${cookie}; ${sessionCookie.split(";")[0]}`;
    await signedIn.text();
    const other = await fetch(`${base}/boards/other-owner`);
    await other.text();
    const access = await fetch(`${base}/api/boards/other-owner`, {
      headers: { cookie: adminCookie },
    });
    assert.equal((await access.json()).canDelete, true);
    const deleted = await fetch(`${base}/api/boards/other-owner`, {
      method: "DELETE",
      headers: { cookie: adminCookie, "x-wbo-delete": "1" },
    });
    assert.equal(deleted.status, 204);
    const protectedBoard = await fetch(`${base}/api/boards/anonymous`, {
      method: "DELETE",
      headers: { cookie: adminCookie, "x-wbo-delete": "1" },
    });
    assert.equal(protectedBoard.status, 403);
    await protectedBoard.text();
    const signedOut = await fetch(`${base}/api/admin`, {
      method: "DELETE",
      headers: { cookie: adminCookie, "x-wbo-admin": "1" },
    });
    assert.match(signedOut.headers.get("set-cookie") || "", /Max-Age=0/);
    await signedOut.text();
    const stale = await fetch(`${base}/api/admin`, {
      headers: { cookie: adminCookie },
    });
    assert.equal((await stale.json()).authenticated, false);
    assert.equal(stale.headers.get("cache-control"), "private, no-store");
    await (await login({}, JSON.stringify({ password: "wrong" }))).text();
    const limited = await login(
      {},
      JSON.stringify({ password: config.BOARD_ADMIN_KEY }),
    );
    assert.equal(limited.status, 429);
    await limited.text();
  } finally {
    await closeServer(app);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
