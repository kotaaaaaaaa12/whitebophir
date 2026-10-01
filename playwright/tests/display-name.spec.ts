import { MutationType } from "../../client-data/js/mutation_type.js";
import { Cursor } from "../../client-data/tools/index.js";
import { createBoardPage, expect, test } from "../fixtures/test";

test("display names update lists, existing cursors and tabs, and survive reload", async ({
  boardPage,
  server,
  context,
  browser,
}) => {
  const siblingPage = await context.newPage();
  const sibling = createBoardPage(siblingPage, server);
  const peerContext = await browser.newContext();
  try {
    const peerPage = await peerContext.newPage();
    const peer = createBoardPage(peerPage, server);
    await Promise.all([
      boardPage.gotoBoard("display-names"),
      sibling.gotoBoard("display-names"),
      peer.gotoBoard("display-names"),
    ]);
    await Promise.all([
      boardPage.waitForSocketConnected(),
      sibling.waitForSocketConnected(),
      peer.waitForSocketConnected(),
      peer.waitForToolBooted("cursor"),
    ]);
    const socketId = await boardPage.page.evaluate(
      () => window.WBOApp.connection.socket?.id,
    );
    await boardPage.emitBroadcast({
      tool: Cursor.id,
      type: MutationType.UPDATE,
      x: 640,
      y: 210,
      color: "#001f3f",
      size: 10,
    });
    const cursorName = peerPage.locator(`#cursor-${socketId} .opcursor-name`);
    await expect(cursorName).toHaveCount(1);
    await boardPage.connectedUsersToggle.click();
    await sibling.connectedUsersToggle.click();
    await peer.connectedUsersToggle.click();
    const selfName = boardPage.page.locator(
      ".connected-user-row-self .connected-user-name-text",
    );
    const userId = await boardPage.page
      .locator(".connected-user-row-self")
      .getAttribute("data-user-id");
    await boardPage.page.locator("#displayNameInput").fill("こた 🎨");
    await boardPage.page.locator("#displayNameForm button").click();
    await expect(selfName).toHaveText("こた 🎨");
    await expect(cursorName).toHaveText("こた 🎨");
    await expect(
      peerPage.locator(
        `.connected-user-row[data-socket-id="${socketId}"] .connected-user-name-text`,
      ),
    ).toHaveText("こた 🎨");
    await expect(
      siblingPage.locator(".connected-user-row-self .connected-user-name-text"),
    ).toHaveText("こた 🎨");
    await expect(siblingPage.locator("#displayNameInput")).toHaveValue(
      "こた 🎨",
    );
    await expect(
      boardPage.page.locator(".connected-user-row-self"),
    ).toHaveAttribute("data-user-id", userId || "");
    await boardPage.page.reload();
    await boardPage.waitForSocketConnected();
    await boardPage.connectedUsersToggle.click();
    await expect(boardPage.page.locator("#displayNameInput")).toHaveValue(
      "こた 🎨",
    );
    await expect(selfName).toHaveText("こた 🎨");
    await boardPage.page.locator("#displayNameInput").fill("<b>Kota</b>");
    await boardPage.page.locator("#displayNameForm button").click();
    await expect(selfName).toHaveText("<b>Kota</b>");
    await expect(selfName.locator("b")).toHaveCount(0);
    await boardPage.page.locator("#displayNameInput").fill("x".repeat(33));
    await boardPage.page.locator("#displayNameForm button").click();
    await expect(boardPage.page.locator("#displayNameStatus")).toHaveText(
      "Use up to 32 characters without control characters.",
    );
    await expect(selfName).toHaveText("<b>Kota</b>");
    await boardPage.page.locator("#displayNameInput").fill("");
    await boardPage.page.locator("#displayNameForm button").click();
    await expect(selfName).not.toHaveText("<b>Kota</b>");
    await expect
      .poll(() =>
        boardPage.page.evaluate(() => localStorage.getItem("wbo.displayName")),
      )
      .toBe("");
  } finally {
    await peerContext.close();
  }
});
