import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createBoardPage, expect, test } from "../fixtures/test";

test.use({
  hasTouch: true,
  viewport: { width: 390, height: 844 },
  serverOptions: {
    useJWT: false,
    env: { WBO_BOARD_ADMIN_KEY: "dashboard-private-test-key" },
  },
});

test("administrator dashboard signs in directly, searches all private boards, opens and deletes another person's board, then protects the list on logout", async ({
  page,
  context,
  browser,
  server,
}) => {
  const peerContext = await browser.newContext();
  try {
    const peerPage = await peerContext.newPage();
    const peer = createBoardPage(peerPage, server);
    await peer.gotoBoard("private-catalog-target");
    await peer.drawRectangle("#123456", { x: 100, y: 100 }, { x: 140, y: 140 });
    const peerCatalog = await peerPage.request.get(
      `${server.serverUrl}/api/admin/boards`,
    );
    expect(peerCatalog.status()).toBe(403);
    expect(await peerCatalog.text()).not.toContain("private-catalog-target");
    // The public board is included but protected from deletion.
    const publicPage = await peerContext.newPage();
    const publicBoard = createBoardPage(publicPage, server);
    await publicBoard.gotoBoard("anonymous");
    await publicBoard.waitForSocketConnected();
    await page.goto(`${server.serverUrl}/admin`);
    await expect(
      page.getByRole("heading", { name: "Administrator sign in" }),
    ).toBeVisible();
    await expect(page.locator("#adminManager")).toBeHidden();
    await page.getByLabel("Board admin key").tap();
    await page
      .getByLabel("Board admin key")
      .pressSequentially("dashboard-private-test-key");
    await page.getByLabel("Board admin key").press("Enter");
    const target = page
      .getByRole("row")
      .filter({ hasText: "private-catalog-target" });
    await expect(target).toBeVisible();
    const publicRow = page.getByRole("row").filter({ hasText: "anonymous" });
    await expect(
      publicRow.getByRole("button", { name: "Delete anonymous", exact: true }),
    ).toBeDisabled();
    const popupPromise = page.waitForEvent("popup");
    await target
      .getByRole("link", { name: "Open private-catalog-target", exact: true })
      .tap();
    const popup = await popupPromise;
    const opened = createBoardPage(popup, server);
    await opened.waitForSocketConnected();
    await expect(opened.tool("clear")).toBeVisible();
    await expect(popup.locator("#drawingArea rect")).toHaveCount(1);
    await popup.close();
    await page.getByLabel("Search board names").fill("PRIVATE-CATALOG");
    await page.getByRole("button", { name: "Search", exact: true }).tap();
    await expect(page.locator("#boardRows tr")).toHaveCount(1);
    await target
      .getByRole("button", {
        name: "Delete private-catalog-target",
        exact: true,
      })
      .tap();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .tap();
    await expect(target).toBeVisible();
    await target
      .getByRole("button", {
        name: "Delete private-catalog-target",
        exact: true,
      })
      .tap();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete board", exact: true })
      .tap();
    await expect(target).toHaveCount(0);
    await expect(peerPage).not.toHaveURL(/boards\/private-catalog-target/);
    expect(
      (
        await page.request.get(
          `${server.serverUrl}/boards/private-catalog-target`,
        )
      ).status(),
    ).toBe(410);
    await page.getByLabel("Search board names").fill("missing-board");
    await page.getByRole("button", { name: "Search", exact: true }).tap();
    await expect(page.locator("#emptyBoards")).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).tap();
    await expect(page.locator("#adminLogin")).toBeVisible();
    await expect(page.locator("#boardRows tr")).toHaveCount(0);
    expect(
      (await page.request.get(`${server.serverUrl}/api/admin/boards`)).status(),
    ).toBe(403);
    await publicPage.close();
    expect(
      (await context.cookies()).some(
        (cookie) => cookie.name === "wbo-admin-v1",
      ),
    ).toBe(false);
  } finally {
    await peerContext.close();
  }
});

test("administrator dashboard loads subsequent pages, retains refresh/search, and fits a narrow touch viewport", async ({
  page,
  server,
}) => {
  await Promise.all(
    Array.from({ length: 103 }, (_, index) =>
      writeFile(
        path.join(
          server.dataPath,
          `board-private-${String(index).padStart(3, "0")}.owner.json`,
        ),
        JSON.stringify({ owner: null, deleted: false }),
      ),
    ),
  );
  await page.goto(`${server.serverUrl}/admin`);
  await page.getByLabel("Board admin key").fill("dashboard-private-test-key");
  await page.getByRole("button", { name: "Sign in", exact: true }).tap();
  await expect(page.locator("#boardRows tr")).toHaveCount(100);
  await page.getByRole("button", { name: "Load more", exact: true }).tap();
  await expect(page.locator("#boardRows tr")).toHaveCount(103);
  await expect(
    page.getByRole("button", { name: "Load more", exact: true }),
  ).toBeHidden();
  await page.getByLabel("Search board names").fill("private-10");
  await page.getByRole("button", { name: "Search", exact: true }).tap();
  await expect(page.locator("#boardRows tr")).toHaveCount(3);
  await page.getByRole("button", { name: "Refresh", exact: true }).tap();
  await expect(page.locator("#boardRows tr")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // Another tab signs out; returning to the dashboard must remove private names.
  await page.request.delete(`${server.serverUrl}/api/admin`, {
    headers: { "x-wbo-admin": "1" },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#adminManager")).toBeHidden();
  await expect(page.locator("#boardRows tr")).toHaveCount(0);
});

test.describe("Japanese administrator dashboard", () => {
  test.use({ locale: "ja-JP" });

  test("automatically localizes Japanese, switches live without losing search, opens Japanese boards and translates errors and deletion confirmation", async ({
    page,
    server,
  }) => {
    for (const name of ["anonymous", "日本語のボード", "other-private-board"]) {
      await writeFile(
        path.join(server.dataPath, `board-${name}.owner.json`),
        JSON.stringify({ owner: null, deleted: false }),
      );
    }
    await page.goto(`${server.serverUrl}/admin`);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(
      page.getByRole("heading", { name: "すべてのボード", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("表示言語")).toHaveValue("auto");
    await page.getByLabel("管理パスワード").fill("wrong-password");
    await page.getByRole("button", { name: "ログイン", exact: true }).tap();
    await expect(page.locator("#adminStatus")).toContainText(
      "ログインできませんでした",
    );
    await page.getByLabel("表示言語").selectOption("en");
    await expect(page.locator("#adminStatus")).toContainText("Sign in failed");
    await page.getByLabel("Language").selectOption("auto");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await page.getByLabel("管理パスワード").fill("dashboard-private-test-key");
    await page.getByRole("button", { name: "ログイン", exact: true }).tap();
    await expect(page.locator("#boardCount")).toHaveText("3件のボードを表示中");
    const protectedButton = page.getByRole("button", {
      name: "anonymousを削除",
      exact: true,
    });
    await expect(protectedButton).toBeDisabled();
    await page.getByLabel("表示言語").selectOption("en");
    await expect(
      page.getByRole("button", { name: "Delete anonymous", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("Language").selectOption("ja");
    await page.getByLabel("ボード名を検索").fill("日本語");
    await page.getByRole("button", { name: "検索", exact: true }).tap();
    await expect(page.locator("#boardCount")).toHaveText("1件のボードを表示中");
    await page.getByLabel("表示言語").selectOption("en");
    await expect(page.locator("#boardRows tr")).toHaveCount(1);
    await expect(page.getByLabel("Search board names")).toHaveValue("日本語");
    await expect(page.locator("#boardCount")).toHaveText("Boards loaded: 1");
    await page.getByLabel("Language").selectOption("ja");
    const popupPromise = page.waitForEvent("popup");
    await page
      .getByRole("link", { name: "日本語のボードを開く", exact: true })
      .tap();
    const popup = await popupPromise;
    const opened = createBoardPage(popup, server);
    await opened.waitForSocketConnected();
    await expect(popup.locator("html")).toHaveAttribute("lang", "ja");
    await opened.connectedUsersToggle.tap();
    await expect(popup.locator("#adminSessionButton")).toHaveText("管理者");
    await expect(popup.locator(".admin-boards-link")).toHaveText(
      "すべてのボード",
    );
    await expect(popup.locator(".admin-boards-link")).toHaveAttribute(
      "href",
      /lang=ja/,
    );
    await expect(popup.locator("#deleteBoardButton")).toHaveText(
      "ボードを削除",
    );
    await expect(popup.locator("#chooseColor")).toHaveAttribute(
      "aria-label",
      "カスタムカラー",
    );
    await popup.close();
    await page
      .getByRole("button", { name: "日本語のボードを削除", exact: true })
      .tap();
    const confirmation = page.getByRole("dialog", { name: "ボードを削除" });
    await expect(confirmation).toContainText("この操作は元に戻せません");
    await confirmation
      .getByRole("button", { name: "キャンセル", exact: true })
      .tap();
    await expect(page.locator("#boardRows tr")).toHaveCount(1);
    const catalogUrl = `${server.serverUrl}/api/admin/boards*`;
    await page.route(catalogUrl, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: "{}",
      }),
    );
    await page.getByRole("button", { name: "更新", exact: true }).tap();
    await expect(page.locator("#adminStatus")).toHaveText(
      "ボード一覧を読み込めませんでした（HTTP 503）。",
    );
    await page.unroute(catalogUrl);
    await page.getByRole("button", { name: "更新", exact: true }).tap();
    await expect(page.locator("#adminStatus")).toBeEmpty();
    await expect(page.locator("#boardRows tr")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await expect(page.getByLabel("表示言語")).toHaveValue("ja");
    await expect(page.locator("#boardRows tr")).toHaveCount(3);
    await page.getByRole("button", { name: "ログアウト", exact: true }).tap();
    await expect(page.locator("#adminStatus")).toHaveText(
      "ログアウトしました。",
    );
    await page.getByLabel("表示言語").selectOption("en");
    await expect(page.locator("#adminStatus")).toHaveText("Signed out.");
    await expect(page.locator("#boardRows tr")).toHaveCount(0);
  });

  test("persists a manual language override, supports Auto and honors an explicit URL language", async ({
    page,
    server,
  }) => {
    await page.goto(`${server.serverUrl}/admin`);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await page.getByLabel("表示言語").selectOption("en");
    await page.goto(`${server.serverUrl}/admin`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByLabel("Language")).toHaveValue("en");
    await page.getByLabel("Language").selectOption("auto");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await page.goto(`${server.serverUrl}/admin?lang=en`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.goto(`${server.serverUrl}/admin?lang=ja`);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(
      page.getByRole("heading", { name: "管理者ログイン", exact: true }),
    ).toBeVisible();
  });
});
