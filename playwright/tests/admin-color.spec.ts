import { createBoardPage, expect, test } from "../fixtures/test";

test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

test("native custom color receives trusted touch across the whole swatch and updates drawing preferences", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("native-color-touch");
  await boardPage.waitForSocketConnected();
  await page.locator("#styleSummary").tap();
  const input = page.locator("#chooseColor");
  await expect(input).toHaveAttribute("type", "color");
  await expect(input).toHaveAttribute("aria-label", "Custom color");
  await expect(input).not.toHaveAttribute("tabindex", "-1");
  expect(
    await input.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const swatch = node.parentElement?.getBoundingClientRect();
      if (!swatch) throw new Error("Native color input is not mounted");
      return {
        width: bounds.width,
        height: bounds.height,
        coversCenter:
          document.elementFromPoint(
            swatch.x + swatch.width / 2,
            swatch.y + swatch.height / 2,
          ) === node,
        coversCorner:
          document.elementFromPoint(swatch.x + 2, swatch.y + 2) === node,
        swatchWidth: swatch.width,
        swatchHeight: swatch.height,
      };
    }),
  ).toMatchObject({ coversCenter: true, coversCorner: true });
  await input.evaluate((node) => {
    node.addEventListener("click", (event) => {
      node.dataset.trustedTap = String(event.isTrusted);
      node.dataset.tapPrevented = String(event.defaultPrevented);
    });
  });
  await page.locator("#colorPresetCustom").tap();
  await expect(input).toHaveAttribute("data-trusted-tap", "true");
  await expect(input).toHaveAttribute("data-tap-prevented", "false");
  await expect(page.locator(".custom-color-dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Native OS picker chrome is outside the page. Exercise its standard events
  // after confirming that a real tap reached the actual color input.
  await input.evaluate((node: HTMLInputElement) => {
    node.value = "#abcdef";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.preferences.currentColor))
    .toBe("#abcdef");
  await expect(page.locator("#stylePreviewDot")).toHaveAttribute(
    "fill",
    "#abcdef",
  );
  await input.evaluate((node: HTMLInputElement) => {
    node.value = "#112233";
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.preferences.currentColor))
    .toBe("#112233");
  await page.locator("#styleSummary").tap();
  await expect(page.locator("#stylePanel")).toBeHidden();
  await boardPage.selectTool("rectangle");
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(450, 350);
  await page.mouse.up();
  await expect(page.locator("#drawingArea rect")).toHaveAttribute(
    "stroke",
    "#112233",
  );
  await page.reload();
  await boardPage.waitForSocketConnected();
  await expect(input).toHaveValue("#112233");
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
