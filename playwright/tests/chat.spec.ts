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
  const list = panel.locator(".board-chat-messages");
  await expect(panel.locator("li")).toHaveCount(50);
  await expect(older).toBeHidden();
  const anchor = await list.evaluate((element) => {
    element.scrollTop = 40;
    const row = element.firstElementChild as HTMLElement;
    return {
      id: row.dataset.messageId,
      top:
        row.getBoundingClientRect().top - element.getBoundingClientRect().top,
    };
  });
  await expect(panel.locator("li")).toHaveCount(100);
  await expect
    .poll(() =>
      list.evaluate((element, anchor) => {
        const row = element.querySelector(`[data-message-id="${anchor.id}"]`);
        if (!row) throw new Error("Reading anchor disappeared");
        return Math.abs(
          row.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            anchor.top,
        );
      }, anchor),
    )
    .toBeLessThanOrEqual(1);
  await list.focus();
  await list.press("Home");
  await expect(panel.locator("li")).toHaveCount(103);
  await expect(older).toBeHidden();
  await expect(panel.locator("li p").first()).toHaveText("saved 1");
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(0);
  for (let opening = 0; opening < 2; opening++) {
    await panel.locator("header button").tap();
    await expect(panel).toBeHidden();
    await page.locator("#boardChatToggle").tap();
    await expect(panel).toBeVisible();
    await expect
      .poll(() =>
        list.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect(panel.locator("li p").last()).toHaveText("saved 103");
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
  }
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

test("automatic history coalesces scrolls, keeps the current reading position and offers retry on failure", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("chat-auto-history");
  await boardPage.waitForSocketConnected();
  await page.evaluate(() => {
    const socket = window.WBOApp.connection.socket;
    if (!socket) throw new Error("Socket is missing");
    const emit = socket.emit.bind(socket);
    const cursors: Array<number | null> = [];
    let attempts = 0;
    socket.emit = ((event: string, ...args: unknown[]) => {
      if (event !== "chat_history") return emit(event, ...args);
      const before = (args[0] as { before?: number }).before ?? null;
      cursors.push(before);
      document.documentElement.dataset.chatHistoryRequests =
        JSON.stringify(cursors);
      const respond = args[1] as (response: unknown) => void;
      if (before === 21) {
        attempts++;
        if (attempts === 1) {
          respond({ ok: false, error: "chat_history_failed" });
          return socket;
        }
        if (attempts === 2) {
          respond({ ok: true, messages: [], nextBefore: before });
          return socket;
        }
      }
      const end = (before ?? 121) - 1;
      const start = Math.max(1, end - 49);
      const reply = () =>
        respond({
          ok: true,
          nextBefore: start > 1 ? start : null,
          messages: Array.from({ length: end - start + 1 }, (_, index) => ({
            id: start + index,
            name: "Reader",
            text: `saved ${start + index}`,
            sentAt: 1700000000000,
          })),
        });
      if (before === 71)
        document.addEventListener("test:release-chat-history", reply, {
          once: true,
        });
      else reply();
      return socket;
    }) as typeof socket.emit;
  });
  await page.locator("#boardChatToggle").tap();
  const panel = page.locator("#boardChatPanel");
  const list = panel.locator(".board-chat-messages");
  const older = panel.locator(":scope > button");
  await expect(panel.locator("li")).toHaveCount(50);
  await list.evaluate((element) => {
    element.scrollTop = 40;
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-chat-history-requests",
    "[null,71]",
  );
  const anchor = await list.evaluate((element) => {
    element.scrollTop = 160;
    for (let i = 0; i < 5; i++) element.dispatchEvent(new Event("scroll"));
    const top = element.getBoundingClientRect().top;
    const row = Array.from(element.children).find(
      (row) => row.getBoundingClientRect().bottom > top,
    ) as HTMLElement;
    return {
      id: row.dataset.messageId,
      top: row.getBoundingClientRect().top - top,
    };
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-chat-history-requests",
    "[null,71]",
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("test:release-chat-history")),
  );
  await expect(panel.locator("li")).toHaveCount(100);
  await expect
    .poll(() =>
      list.evaluate((element, anchor) => {
        const row = element.querySelector(`[data-message-id="${anchor.id}"]`);
        if (!row) throw new Error("Reading anchor disappeared");
        return Math.abs(
          row.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            anchor.top,
        );
      }, anchor),
    )
    .toBeLessThanOrEqual(1);
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(older).toBeVisible();
  await expect(panel.locator("li")).toHaveCount(100);
  await list.evaluate((element) => {
    for (let i = 0; i < 5; i++) element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-chat-history-requests",
    "[null,71,21]",
  );
  await older.tap();
  // A cursor that does not advance must stop automatic fetches as well.
  await expect(older).toBeVisible();
  await expect(older).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute(
    "data-chat-history-requests",
    "[null,71,21,21]",
  );
  await expect(panel.locator("li")).toHaveCount(100);
  await older.tap();
  await expect(panel.locator("li")).toHaveCount(120);
  await expect(older).toBeHidden();
  await expect(panel.locator("li p").first()).toHaveText("saved 1");
  await list.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-chat-history-requests",
    "[null,71,21,21,21]",
  );
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
    let releaseBoot = () => {};
    const bootGate = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });
    await page.route("**/js/board.js", async (route) => {
      await bootGate;
      await route.continue();
    });
    try {
      await boardPage.gotoBoardShell("chat-cold-touch");
      await expect(page.locator("#boardChatToggle")).toBeDisabled();
    } finally {
      releaseBoot();
    }
    await boardPage.waitForSocketConnected();
    await expect(page.locator("#boardChatToggle")).toBeEnabled();
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
    // A completed touch must still open; even a zero-detail compatibility click cannot close.
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
        new MouseEvent("click", { detail: 0, bubbles: true, cancelable: true }),
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

adminChatTest(
  "only administrators see the right-side trash control and deletion clears peers, stale history replies and persisted reloads",
  async ({ boardPage, page, browser, server }, testInfo) => {
    await boardPage.gotoBoard("chat-delete-browser");
    await boardPage.waitForSocketConnected();
    const peerContext = await browser.newContext();
    try {
      const peerPage = await peerContext.newPage();
      const peer = createBoardPage(peerPage, server);
      await peer.gotoBoard("chat-delete-browser");
      await peer.waitForSocketConnected();
      await peerPage.locator("#boardChatToggle").click();
      await peerPage
        .locator("#boardChatInput")
        .fill("a peer message to remove");
      await peerPage.locator("#boardChatInput").press("Enter");
      await expect(peerPage.locator("#boardChatPanel li")).toHaveCount(1);
      await expect(peerPage.locator(".board-chat-delete")).toHaveCount(0);
      const login = await page.request.post(`${server.serverUrl}/api/admin`, {
        headers: { "x-wbo-admin": "1" },
        data: { password: "chat-browser-password" },
      });
      expect(login.status()).toBe(200);
      await page.reload();
      await boardPage.waitForSocketConnected();
      await page.locator("#boardChatToggle").tap();
      const trash = page.locator(".board-chat-delete");
      await expect(trash).toBeVisible();
      expect(
        await page
          .locator("#boardChatPanel li")
          .evaluate((node) => parseFloat(getComputedStyle(node).paddingRight)),
      ).toBeGreaterThanOrEqual(32);
      const row = await page.locator("#boardChatPanel li").boundingBox();
      const bounds = await trash.boundingBox();
      if (!row || !bounds) throw new Error("Message control missing");
      expect(bounds.x + bounds.width).toBeGreaterThan(row.x + row.width - 10);
      await page.screenshot({ path: testInfo.outputPath("trash.png") });
      await trash.tap();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("a peer message to remove");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
      await expect(page.locator("#boardChatPanel")).toBeVisible();
      await expect(page.locator("#boardChatPanel li")).toHaveCount(1);
      // Hold an old history reply while real deletion is broadcast to this peer.
      await peerPage.reload();
      await peer.waitForSocketConnected();
      await peerPage.evaluate(() => {
        const socket = window.WBOApp.connection.socket;
        if (!socket) throw new Error("No socket");
        const emit = socket.emit.bind(socket);
        socket.emit = ((event: string, ...args: unknown[]) => {
          if (event === "chat_history") {
            const ack = args[1] as (value: unknown) => void;
            return emit(event, args[0], (value: unknown) => {
              document.body.dataset.chatHistoryHeld = "true";
              document.addEventListener(
                "test:release-history",
                () => ack(value),
                { once: true },
              );
            });
          }
          return emit(event, ...args);
        }) as typeof socket.emit;
      });
      await peerPage.locator("#boardChatToggle").click();
      await expect(peerPage.locator("body")).toHaveAttribute(
        "data-chat-history-held",
        "true",
      );
      await trash.tap();
      await dialog
        .getByRole("button", { name: "Delete message", exact: true })
        .tap();
      await expect(page.locator("#boardChatPanel li")).toHaveCount(0);
      await expect(
        peerPage.locator("#boardChatPanel [role=status]"),
      ).toContainText("No messages yet");
      await peerPage.evaluate(() =>
        document.dispatchEvent(new Event("test:release-history")),
      );
      await expect(peerPage.locator("#boardChatPanel li")).toHaveCount(0);
      await peerPage.reload();
      await peer.waitForSocketConnected();
      await peerPage.locator("#boardChatToggle").click();
      await expect(
        peerPage.locator("#boardChatPanel [role=status]"),
      ).toContainText("No messages yet");
      await expect(peerPage.locator("#boardChatPanel li")).toHaveCount(0);
    } finally {
      await peerContext.close();
    }
  },
);

test.describe("live unread badge", () => {
  adminChatTest(
    "badge receives before chat loads, excludes own/retried/history messages and removes deleted unread messages",
    async ({ boardPage, page, browser, server }, testInfo) => {
      await boardPage.gotoBoard("chat-unread");
      await boardPage.waitForSocketConnected();
      const badge = page.locator("#boardChatUnread");
      const toggle = page.locator("#boardChatToggle");
      await expect(badge).toBeHidden();
      await expect(page.locator("#boardChatPanel")).toHaveCount(0);
      const peerContext = await browser.newContext();
      try {
        const peerPage = await peerContext.newPage();
        const peer = createBoardPage(peerPage, server);
        await peer.gotoBoard("chat-unread");
        await peer.waitForSocketConnected();
        const nonce = randomUUID();
        const send = (text: string, clientId = randomUUID()) =>
          peerPage.evaluate(
            async ({ text, clientId }) => {
              const socket = window.WBOApp.connection.socket;
              if (!socket) throw new Error("Missing socket");
              return await new Promise<
                import("../../client-data/js/chat_protocol.js").ChatSendResult
              >((resolve) =>
                socket.emit("chat_send", { text, clientId }, resolve),
              );
            },
            { text, clientId },
          );
        expect((await send("First unread", nonce)).ok).toBe(true);
        await expect(badge).toHaveText("1");
        expect((await send("Retry", nonce)).ok).toBe(true);
        await expect(badge).toHaveText("1");
        expect((await send("Second unread")).ok).toBe(true);
        await expect(badge).toHaveText("2");
        await expect(toggle).toHaveAttribute(
          "aria-label",
          "Chat: 2 unread messages",
        );
        await expect(page.locator("#boardChatPanel")).toHaveCount(0);
        const box = await toggle.boundingBox();
        const bubble = await badge.boundingBox();
        if (!box || !bubble) throw new Error("Missing badge geometry");
        expect(bubble.x).toBeGreaterThan(box.x + box.width / 2);
        expect(bubble.y).toBeLessThan(box.y + 5);
        await page.screenshot({ path: testInfo.outputPath("chat-unread.png") });
        await toggle.tap();
        await expect(badge).toBeHidden();
        await expect(page.locator("#boardChatPanel li")).toHaveCount(2);
        await page.locator("#boardChatInput").fill("Own message");
        await page.locator('.board-chat-form button[type="submit"]').tap();
        await expect(page.locator("#boardChatPanel li")).toHaveCount(3);
        await toggle.tap();
        await expect(badge).toBeHidden();
        const last = await send("Deleted unread");
        if (!last.ok) throw new Error("Send failed");
        await expect(badge).toHaveText("1");
        const signIn = await peerPage.request.post(
          `${server.serverUrl}/api/admin`,
          {
            headers: { "x-wbo-admin": "1" },
            data: { password: "chat-browser-password" },
          },
        );
        expect(signIn.ok()).toBe(true);
        await peerPage.reload();
        await peer.waitForSocketConnected();
        await peerPage.evaluate(async (id) => {
          const socket = window.WBOApp.connection.socket;
          if (!socket) throw new Error("Missing socket");
          await new Promise<void>((resolve, reject) =>
            socket.emit("chat_delete", { id }, (result) =>
              result.ok ? resolve() : reject(new Error(result.error)),
            ),
          );
        }, last.message.id);
        await expect(badge).toBeHidden();
        await toggle.tap();
        await expect(page.locator("#boardChatPanel li")).toHaveCount(3);
        await toggle.tap();
        await expect(badge).toBeHidden();
      } finally {
        await peerContext.close();
      }
    },
  );
});
