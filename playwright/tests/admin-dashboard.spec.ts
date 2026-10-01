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
