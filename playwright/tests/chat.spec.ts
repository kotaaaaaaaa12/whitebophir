import { randomUUID } from "node:crypto";
import { createBoardPage, expect, test } from "../fixtures/test";

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

test("chat sits under people, shares literal messages only with its board and restores history on reload", async ({
  boardPage,
  page,
  browser,
  server,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("wbo.displayName", "こた"),
  );
  await boardPage.gotoBoard("chat-shared");
  await boardPage.waitForSocketConnected();
  const people = await boardPage.connectedUsersToggle.boundingBox();
  const button = await page.locator("#boardChatToggle").boundingBox();
  if (!people || !button) throw new Error("Board controls are missing");
  expect(button.y).toBeGreaterThanOrEqual(people.y + people.height);
  await page.locator("#boardChatToggle").tap();
  const panel = page.locator("#boardChatPanel");
  await expect(panel).toBeVisible();
  await expect(panel.locator('[role="status"]')).toContainText(
    "No messages yet",
  );
  const peerContext = await browser.newContext();
  try {
    const peerPage = await peerContext.newPage();
    const peer = createBoardPage(peerPage, server);
    await peer.gotoBoard("chat-shared");
    await peer.waitForSocketConnected();
    await peerPage.locator("#boardChatToggle").click();
    const message = '<img src=x onerror="alert(1)"> 日本語 🌸';
    await page.locator("#boardChatInput").fill(message);
    await panel.locator('button[type="submit"]').tap();
    await expect(panel.locator("li p")).toHaveText(message);
    await expect(panel.locator("li bdi")).toHaveText("こた");
    await expect(panel.locator("li time")).toHaveAttribute("datetime", /T/);
    await expect(panel.locator("img")).toHaveCount(0);
    await expect(peerPage.locator("#boardChatPanel li p")).toHaveText(message);
    await expect(panel.locator("li")).toHaveCount(1);
    await page.reload();
    await boardPage.waitForSocketConnected();
    await page.locator("#boardChatToggle").tap();
    await expect(panel.locator("li p")).toHaveText(message);
    await peer.gotoBoard("chat-isolated");
    await peer.waitForSocketConnected();
    await peerPage.locator("#boardChatToggle").click();
    await expect(
      peerPage.locator("#boardChatPanel [role=status]"),
    ).toContainText("No messages yet");
    await expect(peerPage.locator("#boardChatPanel li")).toHaveCount(0);
    await boardPage.connectedUsersToggle.tap();
    await expect(panel).toBeHidden();
  } finally {
    await peerContext.close();
  }
});

test("chat keyboard preserves focus and board tool, handles composition and multiline, and keeps a failed draft for retry", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("chat-keyboard");
  await boardPage.waitForSocketConnected();
  await boardPage.selectTool("hand");
  const activeTool = await boardPage.readActiveToolState();
  const color = await page.locator("#chooseColor").inputValue();
  await page.locator("#boardChatToggle").tap();
  await expect(page.locator("#boardChatPanel [role=status]")).toContainText(
    "No messages yet",
  );
  const input = page.locator("#boardChatInput");
  await input.tap();
  await input.pressSequentially("pehrz[].,sod");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("pehrz[].,sod");
  expect(await boardPage.readActiveToolState()).toEqual(activeTool);
  await expect(page.locator("#chooseColor")).toHaveValue(color);
  await input.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    bubbles: true,
  });
  await expect(page.locator("#boardChatPanel li")).toHaveCount(0);
  await input.press("Shift+Enter");
  await input.pressSequentially("next line");
  await expect(input).toHaveValue("pehrz[].,sod\nnext line");
  // Make one request fail deterministically, then use the real transport on retry.
  await page.evaluate(() => {
    const socket = window.WBOApp.connection.socket;
    if (!socket) throw new Error("Socket is missing");
    const emit = socket.emit.bind(socket);
    let failed = false;
    socket.emit = ((event: string, ...args: unknown[]) => {
      if (event === "chat_send" && !failed) {
        failed = true;
        (args[1] as (result: unknown) => void)({
          ok: false,
          error: "chat_send_failed",
        });
        return socket;
      }
      return emit(event, ...args);
    }) as typeof socket.emit;
  });
  await input.press("Enter");
  await expect(page.locator("#boardChatPanel [role=status]")).toContainText(
    "could not be sent",
  );
  await expect(input).toHaveValue("pehrz[].,sod\nnext line");
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(page.locator("#boardChatPanel li p")).toHaveText(
    "pehrz[].,sod\nnext line",
  );
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(page.locator("#boardChatPanel")).toBeHidden();
});

test("history paginates beyond 100 messages and stays inside short mobile and RTL viewports", async ({
  boardPage,
  page,
}, testInfo) => {
  await boardPage.gotoBoard("chat-pagination", { query: { lang: "ar" } });
  await boardPage.waitForSocketConnected();
  const clientId = randomUUID();
  // Public history protocol supplies fixtures; rendering remains the real lazy panel.
  await page.evaluate(
    ({ clientId }) => {
      const socket = window.WBOApp.connection.socket;
      if (!socket) throw new Error("Socket is missing");
      const emit = socket.emit.bind(socket);
      socket.emit = ((event: string, ...args: unknown[]) => {
        if (event === "chat_history") {
          const before = (args[0] as { before?: number }).before ?? 104;
          const end = before - 1,
            start = Math.max(1, end - 49);
          const messages = Array.from(
            { length: end - start + 1 },
            (_, index) => ({
              id: start + index,
              name: clientId,
              text: `saved ${start + index}`,
              sentAt: 1700000000000,
            }),
          );
          (args[1] as (result: unknown) => void)({
            ok: true,
            messages,
            nextBefore: start > 1 ? start : null,
          });
          return socket;
        }
        return emit(event, ...args);
      }) as typeof socket.emit;
    },
    { clientId },
  );
  await page.locator("#boardChatToggle").tap();
  const panel = page.locator("#boardChatPanel");
  const older = panel.locator(":scope > button");
  await expect(panel.locator("li")).toHaveCount(50);
  await older.tap();
  await expect(panel.locator("li")).toHaveCount(100);
  await older.tap();
  await expect(panel.locator("li")).toHaveCount(103);
  await expect(older).toBeHidden();
  await expect(panel.locator("li p").first()).toHaveText("saved 1");
  await expect(panel).toHaveAttribute("dir", "rtl");
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 667, height: 375 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const bounds = await panel.boundingBox();
        return (
          !!bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= viewport.width &&
          bounds.y + bounds.height <= viewport.height
        );
      })
      .toBe(true);
    await expect(page.locator("#boardChatInput")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`chat-${viewport.width}.png`),
    });
  }
});

test("a cold touch activation opens once despite extra taps and touch needs no compatibility click", async ({
  boardPage,
  page,
}) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = () => {};
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/js/board_chat.js*", async (route) => {
    requested();
    await gate;
    await route.continue();
  });
  try {
    await boardPage.gotoBoard("chat-cold-touch");
    await boardPage.waitForSocketConnected();
    const button = page.locator("#boardChatToggle");
    await button.tap();
    await started;
    await expect(button).toHaveAttribute("aria-busy", "true");
    await button.tap();
    release();
    const panel = page.locator("#boardChatPanel");
    await expect(panel).toBeVisible();
    await expect(button).not.toHaveAttribute("aria-busy", "true");
    await expect(panel).toHaveCount(1);
    await button.tap();
    await expect(panel).toBeHidden();
    // A completed touch without click must still open; its delayed click cannot close.
    await button.evaluate((node) => {
      for (const type of ["pointerdown", "pointerup"])
        node.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 99,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            clientX: 20,
            clientY: 20,
            bubbles: true,
            cancelable: true,
          }),
        );
      node.dispatchEvent(
        new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }),
      );
    });
    await expect(panel).toBeVisible();
    await button.tap();
    await expect(panel).toBeHidden();
    await button.evaluate((node) => {
      node.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: 100,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          bubbles: true,
        }),
      );
      node.dispatchEvent(
        new PointerEvent("pointercancel", {
          pointerId: 100,
          pointerType: "touch",
          bubbles: true,
        }),
      );
      node.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerId: 100,
          pointerType: "touch",
          bubbles: true,
        }),
      );
    });
    await expect(panel).toBeHidden();
    await button.focus();
    await button.press("Space");
    await expect(panel).toBeVisible();
    await button.press("Enter");
    await expect(panel).toBeHidden();
  } finally {
    release();
  }
});

const adminChatTest = test.extend({
  serverOptions: {
    useJWT: false,
    env: { WBO_BOARD_ADMIN_KEY: "chat-browser-password" },
  },
});
adminChatTest(
  "administrator chat flower reaches peers and history and is removed from new messages after logout",
  async ({ boardPage, page, browser, server }) => {
    await page.addInitScript(() =>
      localStorage.setItem("wbo.displayName", "こた"),
    );
    await boardPage.gotoBoard("chat-admin-browser");
    await boardPage.waitForSocketConnected();
    const response = await page.request.post(`${server.serverUrl}/api/admin`, {
      headers: { "x-wbo-admin": "1" },
      data: { password: "chat-browser-password" },
    });
    expect(response.status()).toBe(200);
    await page.reload();
    await boardPage.waitForSocketConnected();
    const peerContext = await browser.newContext();
    try {
      const peerPage = await peerContext.newPage();
      const peer = createBoardPage(peerPage, server);
      await peer.gotoBoard("chat-admin-browser");
      await peer.waitForSocketConnected();
      await peerPage.locator("#boardChatToggle").click();
      await page.locator("#boardChatToggle").tap();
      await page.locator("#boardChatInput").fill("administrator message");
      await page.locator("#boardChatInput").press("Enter");
      await expect(peerPage.locator("#boardChatPanel li bdi")).toHaveText(
        "🌸こた",
      );
      await peerPage.reload();
      await peer.waitForSocketConnected();
      await peerPage.locator("#boardChatToggle").click();
      await expect(peerPage.locator("#boardChatPanel li bdi")).toHaveText(
        "🌸こた",
      );
      const reloaded = page.waitForEvent("domcontentloaded");
      const logout = await page.request.delete(
        `${server.serverUrl}/api/admin`,
        { headers: { "x-wbo-admin": "1" } },
      );
      expect(logout.status()).toBe(200);
      await reloaded;
      await boardPage.waitForSocketConnected();
      await page.locator("#boardChatToggle").tap();
      await expect
        .poll(() =>
          page.evaluate(() => window.WBOApp.access.boardState.canClear),
        )
        .toBe(false);
      await boardPage.waitForSocketConnected();
      await page
        .locator("#boardChatInput")
        .fill("ordinary message after logout");
      await page.locator("#boardChatInput").press("Enter");
      await expect(peerPage.locator("#boardChatPanel li bdi")).toHaveText([
        "🌸こた",
        "こた",
      ]);
    } finally {
      await peerContext.close();
    }
  },
);
