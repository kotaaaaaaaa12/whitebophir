import { createBoardPage, expect, test } from "../fixtures/test";

test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

test("custom color opens by touch, applies HEX and RGB, and preserves the color on cancel", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("custom-color-touch");
  await boardPage.waitForSocketConnected();
  await page.locator("#styleSummary").tap();
  await page.locator("#colorPresetCustom").tap();
  const dialog = page.getByRole("dialog", { name: "Custom color" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("HEX color").fill("#abcdef");
  await dialog.getByRole("button", { name: "Apply", exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#chooseColor")).toHaveValue("#abcdef");
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.preferences.currentColor))
    .toBe("#abcdef");
  // Reopen through the actual palette button, including on WebKit touch devices.
  if (!(await page.locator("#stylePanel").isVisible()))
    await page.locator("#styleSummary").tap();
  await page.locator("#colorPresetCustom").tap();
  await dialog.getByLabel("HEX color").fill("#010203");
  await dialog.getByLabel("Red").evaluate((input: HTMLInputElement) => {
    input.value = "128";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(dialog.getByLabel("HEX color")).toHaveValue("#800203");
  await dialog.getByLabel("Blue").tap();
  await expect(dialog.getByLabel("HEX color")).not.toHaveValue("#800203");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
  await expect(page.locator("#chooseColor")).toHaveValue("#abcdef");
  if (!(await page.locator("#stylePanel").isVisible()))
    await page.locator("#styleSummary").tap();
  await page.locator("#colorPresetCustom").tap();
  await dialog.getByLabel("HEX color").fill("invalid");
  await dialog.getByRole("button", { name: "Apply", exact: true }).tap();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("HEX color").fill("112233");
  await dialog.getByRole("button", { name: "Apply", exact: true }).tap();
  await expect(page.locator("#chooseColor")).toHaveValue("#112233");
});

const adminTest = test.extend({
  serverOptions: {
    useJWT: false,
    env: { WBO_BOARD_ADMIN_KEY: "private-browser-test-password" },
  },
});

adminTest(
  "administrator password keeps focus during typing and never activates board shortcuts",
  async ({ boardPage, page }) => {
    await boardPage.gotoBoard("admin-keyboard-focus");
    await boardPage.drawRectangle(
      "#123456",
      { x: 100, y: 100 },
      { x: 140, y: 140 },
    );
    await boardPage.selectTool("pencil");
    await boardPage.selectTool("hand");
    const tool = await boardPage.readActiveToolState();
    const color = await page.locator("#chooseColor").inputValue();
    const size = await page.locator("#chooseSize").inputValue();
    const opacity = await page.locator("#chooseOpacity").inputValue();
    await boardPage.connectedUsersToggle.tap();
    await page.locator("#adminSessionButton").tap();
    const dialog = page.getByRole("dialog", { name: "Administrator sign in" });
    const password = dialog.locator('input[type="password"]');
    await password.tap();
    await password.pressSequentially("pehrz[].,sod");
    await expect(password).toHaveValue("pehrz[].,sod");
    await expect(password).toBeFocused();
    await password.press("Shift+P");
    await expect(password).toHaveValue("pehrz[].,sodP");
    await expect(password).toBeFocused();
    expect(await boardPage.readActiveToolState()).toEqual(tool);
    await expect(page.locator("#chooseColor")).toHaveValue(color);
    await expect(page.locator("#chooseSize")).toHaveValue(size);
    await expect(page.locator("#chooseOpacity")).toHaveValue(opacity);
    await password.press("ControlOrMeta+a");
    await password.press("Backspace");
    await expect(password).toHaveValue("");
    await expect(password).toBeFocused();
    await expect(page.locator("#drawingArea rect")).toHaveCount(1);
    await password.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Once the modal has closed, the board shortcuts should work again.
    await page.locator("#board").click({ position: { x: 400, y: 400 } });
    await page.keyboard.press("p");
    await expect
      .poll(() => boardPage.readActiveToolState())
      .toMatchObject({ tool: "pencil" });
  },
);

adminTest(
  "administrator can clear another person's drawing, delete their board, and sign out every open tab",
  async ({ boardPage, page, context, browser, server }) => {
    const peerContext = await browser.newContext();
    try {
      const peerPage = await peerContext.newPage();
      const peer = createBoardPage(peerPage, server);
      await peer.gotoBoard("admin-shared");
      await peer.drawRectangle(
        "#123456",
        { x: 100, y: 100 },
        { x: 140, y: 140 },
      );
      await boardPage.gotoBoard("admin-shared");
      await boardPage.waitForSocketConnected();
      await expect(page.locator("#drawingArea rect")).toHaveCount(1);
      await expect(boardPage.tool("clear")).toBeHidden();
      await boardPage.connectedUsersToggle.tap();
      await page.locator("#adminSessionButton").tap();
      const login = page.getByRole("dialog", { name: "Administrator sign in" });
      const password = login.locator('input[type="password"]');
      await password.tap();
      await password.pressSequentially("wrong-password");
      await login
        .getByRole("button", { name: "Administrator sign in", exact: true })
        .tap();
      await expect(login.getByRole("status")).toContainText("sign in failed");
      await password.tap();
      await password.pressSequentially("private-browser-test-password");
      await password.press("Enter");
      await expect(boardPage.tool("clear")).toBeVisible();
      await boardPage.waitForSocketConnected();
      await expect(peer.tool("clear")).toBeHidden();
      const secondPage = await context.newPage();
      const second = createBoardPage(secondPage, server);
      await second.gotoBoard("admin-shared");
      await expect(second.tool("clear")).toBeVisible();
      await second.waitForSocketConnected();
      await boardPage.tool("clear").tap();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Clear", exact: true })
        .tap();
      await expect(peerPage.locator("#drawingArea rect")).toHaveCount(0);
      await expect(secondPage.locator("#drawingArea rect")).toHaveCount(0);
      await server.waitForStoredBoard(
        server.dataPath,
        "admin-shared",
        (board) => !Object.keys(board).some((key) => key !== "__wbo_meta__"),
      );
      await peer.gotoBoard("admin-other-owner");
      await boardPage.gotoBoard("admin-other-owner");
      await boardPage.waitForSocketConnected();
      await boardPage.connectedUsersToggle.tap();
      await page.locator("#deleteBoardButton").tap();
      const deletion = page.getByRole("dialog", { name: "Delete board" });
      await expect(deletion.locator('input[type="password"]')).toHaveCount(0);
      await deletion
        .getByRole("button", { name: "Delete board", exact: true })
        .tap();
      await expect(page).not.toHaveURL(/boards\/admin-other-owner/);
      await expect(peerPage).not.toHaveURL(/boards\/admin-other-owner/);
      expect(
        (
          await page.request.get(`${server.serverUrl}/boards/admin-other-owner`)
        ).status(),
      ).toBe(410);
      await boardPage.gotoBoard("admin-shared");
      await boardPage.waitForSocketConnected();
      await boardPage.connectedUsersToggle.tap();
      await page.locator("#adminSessionButton").tap();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Sign out administrator", exact: true })
        .tap();
      await expect(boardPage.tool("clear")).toBeHidden();
      await expect(second.tool("clear")).toBeHidden();
      await second.waitForSocketConnected();
      await expect
        .poll(
          async () =>
            (
              await (
                await page.request.get(`${server.serverUrl}/api/admin`)
              ).json()
            ).authenticated,
        )
        .toBe(false);
      await secondPage.close();
    } finally {
      await peerContext.close();
    }
  },
);

adminTest(
  "administrator session edits readonly boards while ordinary viewers remain readonly",
  async ({ boardPage, server, page }) => {
    await boardPage.gotoBoard("admin-login-first");
    const login = await page.request.post(`${server.serverUrl}/api/admin`, {
      headers: { "x-wbo-admin": "1" },
      data: { password: "private-browser-test-password" },
    });
    expect(login.status()).toBe(200);
    await server.writeBoard(server.dataPath, "admin-readonly", {
      __wbo_meta__: { readonly: true },
    });
    await boardPage.gotoBoard("admin-readonly");
    await expect(boardPage.tool("pencil")).toBeVisible();
    await expect(boardPage.tool("clear")).toBeVisible();
    await boardPage.drawRectangle(
      "#123456",
      { x: 100, y: 100 },
      { x: 140, y: 140 },
    );
    await server.waitForStoredBoard(
      server.dataPath,
      "admin-readonly",
      (board) => Object.keys(board).some((key) => key !== "__wbo_meta__"),
    );
    await page.request.delete(`${server.serverUrl}/api/admin`, {
      headers: { "x-wbo-admin": "1" },
    });
    await expect(boardPage.tool("pencil")).toBeHidden();
    await expect(boardPage.tool("clear")).toBeHidden();
  },
);
