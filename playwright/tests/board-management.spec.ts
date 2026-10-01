import { createBoardPage, expect, test } from "../fixtures/test";

test("color presets fit a short viewport and remain reachable after resizing", async ({
  boardPage,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await boardPage.gotoBoard("color-panel-fit");
  await boardPage.waitForSocketConnected();
  await page.locator("#styleSummary").click();
  const panel = page.locator("#stylePanel");
  const colors = page.locator("#colorPresetSel .colorPresetButton");
  await expect(panel).toBeVisible();
  await expect(colors).toHaveCount(12);
  for (const viewport of [
    { width: 390, height: 320 },
    { width: 320, height: 240 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const bounds = await panel.boundingBox();
        return (
          !!bounds &&
          bounds.x >= 8 &&
          bounds.y >= 8 &&
          bounds.x + bounds.width <= viewport.width - 7 &&
          bounds.y + bounds.height <= viewport.height - 7
        );
      })
      .toBe(true);
    for (let index = 0; index < (await colors.count()); index++) {
      const color = colors.nth(index);
      await color.scrollIntoViewIfNeeded();
      const bounds = await color.boundingBox();
      const panelBounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      expect(panelBounds).not.toBeNull();
      if (!bounds || !panelBounds) throw new Error("Missing color bounds");
      expect(bounds.width).toBeGreaterThan(24);
      expect(Math.abs(bounds.width - bounds.height)).toBeLessThanOrEqual(1);
      expect(bounds.y).toBeGreaterThanOrEqual(panelBounds.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(
        panelBounds.y + panelBounds.height,
      );
    }
    await page.locator("#chooseOpacity").scrollIntoViewIfNeeded();
    await expect(page.locator("#chooseOpacity")).toBeInViewport();
  }
});

test("only the creator can confirm board deletion, viewers leave and the old URL stays gone", async ({
  boardPage,
  server,
  browser,
}) => {
  const peerContext = await browser.newContext();
  try {
    await boardPage.gotoBoard("delete-ui");
    await boardPage.waitForSocketConnected();
    const peerPage = await peerContext.newPage();
    const peer = createBoardPage(peerPage, server);
    await peer.gotoBoard("delete-ui");
    await peer.waitForSocketConnected();
    await peer.connectedUsersToggle.click();
    await peerPage.locator("#deleteBoardButton").click();
    await expect(peerPage.locator("#deleteBoardStatus")).toContainText(
      "Only the creator",
    );
    await expect(peerPage.getByRole("dialog")).toHaveCount(0);
    await boardPage.connectedUsersToggle.click();
    await boardPage.page.locator("#deleteBoardButton").click();
    const dialog = boardPage.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      (
        await boardPage.page.request.get(
          new URL("../api/boards/delete-ui", boardPage.page.url()).href,
        )
      ).status(),
    ).toBe(200);
    const oldUrl = boardPage.page.url();
    await boardPage.page.locator("#deleteBoardButton").click();
    await dialog
      .getByRole("button", { name: "Delete board", exact: true })
      .click();
    await expect(boardPage.page).not.toHaveURL(oldUrl);
    await expect(peerPage).not.toHaveURL(oldUrl);
    expect((await boardPage.page.request.get(oldUrl)).status()).toBe(410);
    const recent = await boardPage.page.evaluate(() =>
      JSON.parse(localStorage.getItem("recent-boards") || "[]"),
    );
    expect(recent).not.toContain("delete-ui");
  } finally {
    await peerContext.close();
  }
});
