const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createConfig,
  closeServer,
  getTcpAddress,
} = require("./test_helpers.js");

test("private board catalog requires a signed administrator session, includes empty/legacy/backup boards and excludes deleted/temp files", async () => {
  const { createServerApp } = await import("../server/server.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-admin-catalog-"));
  const config = createConfig({
    PORT: 0,
    HOST: "127.0.0.1",
    HISTORY_DIR: dir,
    AUTH_SECRET_KEY: "",
    BOARD_ADMIN_KEY: "catalog-test-private-key",
    DEFAULT_BOARD: "permanent",
  });
  const app = await createServerApp(config, { logStarted: false });
  const base = `http://127.0.0.1:${getTcpAddress(app).port}`;
  try {
    const svg = '<svg id="canvas"><g id="drawingArea"></g></svg>';
    for (const file of [
      "board-secret-legacy.svg",
      "board-backup-only.svg.bak",
      "board-json-only.json",
      "board-anonymous.svg",
      "board-permanent.svg",
      "board-gone.svg",
      "board-uncommitted.svg.tmp",
      "board-quarantine.svg.1.quarantine",
    ])
      await fs.writeFile(path.join(dir, file), svg);
    await fs.writeFile(
      path.join(dir, "board-gone.owner.json"),
      JSON.stringify({ owner: null, deleted: true }),
    );
    const page = await fetch(`${base}/admin`);
    const userCookie =
      (page.headers.get("set-cookie") || "").split(";")[0] || "";
    assert.equal(page.headers.get("cache-control"), "private, no-store");
    const html = await page.text();
    assert.equal(html.includes("secret-legacy"), false);
    assert.match(html, /<base href="\/"/);
    const japanese = await fetch(`${base}/admin`, {
      headers: { "accept-language": "ja-JP,en;q=0.9" },
    });
    assert.match(japanese.headers.get("vary") || "", /Accept-Language/);
    const japaneseHtml = await japanese.text();
    assert.match(japaneseHtml, /<html lang="ja" dir="ltr">/);
    assert.match(japaneseHtml, /すべてのボード/);
    assert.match(japaneseHtml, /管理パスワード/);
    assert.equal(japaneseHtml.includes("secret-legacy"), false);
    const english = await fetch(`${base}/admin?lang=en`, {
      headers: { "accept-language": "ja-JP" },
    });
    assert.match(await english.text(), /<html lang="en" dir="ltr">/);
    const { ADMIN_TRANSLATIONS } = await import(
      "../client-data/js/admin_i18n.js"
    );
    for (const [language, dictionary] of Object.entries(ADMIN_TRANSLATIONS)) {
      const localized = await fetch(`${base}/admin?lang=${language}`, {
        headers: { "accept-language": "en" },
      });
      const body = await localized.text();
      const direction = language === "ar" ? "rtl" : "ltr";
      assert.ok(body.includes(`<html lang="${language}" dir="${direction}">`));
      assert.ok(body.includes(dictionary.all_boards || ""), language);
      assert.equal((body.match(/<option value=/g) || []).length, 22);
      assert.equal(body.includes("secret-legacy"), false);
    }
    for (const [header, language] of /** @type {[string, string][]} */ ([
      ["ko-KR,zh-Hant;q=0.9", "zh-TW"],
      ["ja;q=0,fr-CA;q=0.9,en;q=0.8", "fr"],
      ["ar-EG,en;q=0.8", "ar"],
    ])) {
      const localized = await fetch(`${base}/admin`, {
        headers: { "accept-language": header },
      });
      assert.ok((await localized.text()).includes(`<html lang="${language}"`));
    }
    const created = await fetch(`${base}/boards/empty-created`, {
      headers: { cookie: userCookie },
    });
    assert.equal(created.status, 200);
    await created.text();
    const deniedHeaders = /** @type {Record<string, string>[]} */ ([
      {},
      { cookie: userCookie },
      { cookie: userCookie, "x-board-admin-key": config.BOARD_ADMIN_KEY },
    ]);
    for (const headers of deniedHeaders) {
      const denied = await fetch(`${base}/api/admin/boards`, {
        headers,
      });
      assert.equal(denied.status, 403);
      assert.equal((await denied.text()).includes("secret-legacy"), false);
    }
    const login = await fetch(`${base}/api/admin`, {
      method: "POST",
      headers: {
        cookie: userCookie,
        "x-wbo-admin": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: config.BOARD_ADMIN_KEY }),
    });
    assert.equal(login.status, 200);
    const cookie = `${userCookie}; ${(login.headers.get("set-cookie") || "").split(";")[0]}`;
    await login.text();
    const catalog = await fetch(`${base}/api/admin/boards`, {
      headers: { cookie },
    });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers.get("cache-control"), "private, no-store");
    const data =
      /** @type {{boards: {name: string, protected: boolean}[], nextCursor: string | null}} */ (
        await catalog.json()
      );
    assert.deepEqual(
      data.boards.map((board) => board.name),
      [
        "anonymous",
        "backup-only",
        "empty-created",
        "json-only",
        "permanent",
        "secret-legacy",
      ],
    );
    assert.deepEqual(
      data.boards.filter((board) => board.protected).map((board) => board.name),
      ["anonymous", "permanent"],
    );
    assert.equal(data.nextCursor, null);
    assert.equal(JSON.stringify(data).includes("owner"), false);
    const search = await fetch(`${base}/api/admin/boards?q=SECRET`, {
      headers: { cookie },
    });
    assert.deepEqual(
      (await search.json()).boards.map(
        (/** @type {{name: string}} */ board) => board.name,
      ),
      ["secret-legacy"],
    );
    const badQuery = await fetch(
      `${base}/api/admin/boards?after=..%2Fprivate`,
      { headers: { cookie } },
    );
    assert.equal(badQuery.status, 400);
    await badQuery.text();
    const method = await fetch(`${base}/api/admin/boards`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(method.status, 405);
    await method.text();
    const signedOut = await fetch(`${base}/api/admin`, {
      method: "DELETE",
      headers: { cookie, "x-wbo-admin": "1" },
    });
    await signedOut.text();
    const stale = await fetch(`${base}/api/admin/boards`, {
      headers: { cookie },
    });
    assert.equal(stale.status, 403);
    await stale.text();
  } finally {
    await closeServer(app);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("catalog uses stable keyset pagination and administrator identity under a configured base path", async () => {
  const { createServerApp } = await import("../server/server.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-admin-pages-"));
  const config = createConfig({
    PORT: 0,
    HOST: "127.0.0.1",
    BASE_PATH: "/custom/wbo",
    HISTORY_DIR: dir,
    AUTH_SECRET_KEY: "",
    BOARD_ADMIN_KEY: "catalog-page-key",
  });
  const app = await createServerApp(config, { logStarted: false });
  const base = `http://127.0.0.1:${getTcpAddress(app).port}`;
  try {
    await Promise.all(
      Array.from({ length: 103 }, (_, index) =>
        fs.writeFile(
          path.join(
            dir,
            `board-page-${String(index).padStart(3, "0")}.owner.json`,
          ),
          JSON.stringify({ owner: null, deleted: false }),
        ),
      ),
    );
    const page = await fetch(`${base}/admin`);
    assert.match(page.headers.get("set-cookie") || "", /Path=\/custom\/wbo\//);
    assert.match(await page.text(), /<base href="\/custom\/wbo\/"/);
    const userCookie =
      (page.headers.get("set-cookie") || "").split(";")[0] || "";
    const login = await fetch(`${base}/api/admin`, {
      method: "POST",
      headers: {
        cookie: userCookie,
        "x-wbo-admin": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: config.BOARD_ADMIN_KEY }),
    });
    const cookie = `${userCookie}; ${(login.headers.get("set-cookie") || "").split(";")[0]}`;
    await login.text();
    const first = await (
      await fetch(`${base}/api/admin/boards`, { headers: { cookie } })
    ).json();
    assert.equal(first.boards.length, 100);
    assert.equal(first.nextCursor, "page-099");
    const second = await (
      await fetch(`${base}/api/admin/boards?after=${first.nextCursor}`, {
        headers: { cookie },
      })
    ).json();
    assert.deepEqual(
      second.boards.map((/** @type {{name: string}} */ board) => board.name),
      ["page-100", "page-101", "page-102"],
    );
    assert.equal(second.nextCursor, null);
    const borrowed = cookie.replace(
      userCookie,
      "wbo-user-secret-v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const denied = await fetch(`${base}/api/admin/boards`, {
      headers: { cookie: borrowed },
    });
    assert.equal(denied.status, 403);
    await denied.text();
  } finally {
    await closeServer(app);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
