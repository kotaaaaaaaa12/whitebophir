import { createBoardPage, expect, test } from "../fixtures/test";
import type { Page } from "@playwright/test";

async function point(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y }) => {
      const rect =
        window.WBOApp.viewportState.controller.boardRectToViewportRect({
          x,
          y,
          width: 0,
          height: 0,
        });
      return { x: rect.left, y: rect.top };
    },
    { x, y },
  );
}
async function tap(page: Page, x: number, y: number) {
  const p = await point(page, x, y);
  if (await page.evaluate(() => navigator.maxTouchPoints > 0))
    await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}
async function scaleOne(page: Page) {
  await page.evaluate(() => window.WBOApp.viewportState.controller.setScale(1));
  await expect(page.locator("#toolID-pencil")).toHaveAttribute(
    "data-brush-picker-ready",
    "true",
  );
}

test("custom palette adds, selects, reorders, removes and persists colors", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("custom-palette");
  await scaleOne(page);
  await page.locator("#styleSummary").click();
  await page.evaluate(() => window.WBOApp.preferences.setColor("#123456"));
  await page.locator("#paletteAdd").click();
  await expect(page.locator('[data-custom-color="#123456"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#paletteEdit").click();
  await page.locator("#paletteHex").fill("#abcdef");
  await page.locator("#paletteHex").press("Enter");
  const editor = page.locator(".palette-editor-rows");
  await expect(editor.locator(".palette-editor-row")).toHaveCount(2);
  await editor
    .locator(".palette-editor-row")
    .last()
    .getByRole("button", { name: "Move earlier", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("wbo.customPalette") || "[]"),
    ),
  ).toEqual(["#abcdef", "#123456"]);
  await editor
    .locator(".palette-editor-row")
    .last()
    .getByRole("button", { name: "Remove color", exact: true })
    .click();
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.boardPhase === "ready",
  );
  await boardPage.waitForBoardWritable();
  await page.locator("#styleSummary").click();
  await expect(page.locator("[data-custom-color]")).toHaveCount(1);
  await page.locator('[data-custom-color="#abcdef"]').click();
  await expect(page.locator("#chooseColor")).toHaveValue("#abcdef");
});

for (const kind of ["graphite", "marker", "brush"])
  test(`${kind} draws from the icon palette, syncs, saves and supports both erasers`, async ({
    boardPage,
    page,
    context,
    server,
  }) => {
    const name = `brush-${kind}`;
    await boardPage.gotoBoard(name);
    await scaleOne(page);
    await boardPage.waitForBoardWritable();
    const peer = await context.newPage();
    await createBoardPage(peer, server).gotoBoard(name);
    await boardPage.selectTool("pencil");
    await expect(page.locator("#brushPalette")).toBeVisible();
    await page.locator(`[data-brush="${kind}"]`).click();
    await expect(page.locator(`[data-brush="${kind}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.evaluate(() => {
      window.WBOApp.preferences.setColor("#123456");
      window.WBOApp.preferences.setSize(30);
    });
    const start = await point(page, 150, 400),
      end = await point(page, 300, 400);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 16 });
    await page.mouse.up();
    const polygon = page.locator(
      `#drawingArea polygon[data-wbo-paint="${kind}"]`,
    );
    await expect(polygon).toHaveCount(1);
    const id = await polygon.getAttribute("id");
    if (!id) throw new Error("Missing paint id");
    await expect(peer.locator(`#drawingArea #${id}`)).toHaveCount(1);
    const points = await polygon.getAttribute("points");
    await server.waitForStoredBoard(
      server.dataPath,
      name,
      (board) => board[id]?.points === points,
    );
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.dataset.boardPhase === "ready",
    );
    await boardPage.waitForBoardWritable();
    await scaleOne(page);
    await expect(polygon).toHaveAttribute("points", points || "");
    await boardPage.selectTool("eraser");
    await boardPage.selectTool("eraser");
    await page.evaluate(() => window.WBOApp.preferences.setSize(50));
    await tap(page, 220, 400);
    await expect(polygon).toHaveAttribute("data-wbo-erasures", /size/);
    await boardPage.selectTool("eraser");
    // Choose a visible remnant, outside the partially erased hole.
    await tap(page, 175, 400);
    await expect(polygon).toHaveCount(0);
    await expect(peer.locator(`#drawingArea #${id}`)).toHaveCount(0);
  });

test("bucket fills only the enclosed area, persists and erases color without deleting its outline", async ({
  boardPage,
  page,
  server,
  context,
}) => {
  const name = "bucket-persist";
  await server.writeBoard(server.dataPath, name, {
    outline: {
      id: "outline",
      tool: "rectangle",
      x: 14,
      y: 15,
      x2: 31,
      y2: 34,
      color: "#000000",
      size: 1,
    },
    island: {
      id: "island",
      tool: "rectangle",
      x: 23,
      y: 24,
      x2: 27,
      y2: 28,
      color: "#000000",
      size: 1,
    },
  });
  await boardPage.gotoBoard(name);
  await scaleOne(page);
  await boardPage.waitForBoardWritable();
  const peer = await context.newPage();
  await createBoardPage(peer, server).gotoBoard(name);
  await page.evaluate(() => window.WBOApp.preferences.setColor("#ff0000"));
  await boardPage.selectTool("bucket");
  await tap(page, 180, 200);
  const fill = page.locator('#drawingArea polygon[data-wbo-paint="bucket"]');
  await expect(fill).toHaveCount(1);
  const id = await fill.getAttribute("id");
  if (!id) throw new Error("Missing fill id");
  await expect(peer.locator(`#${id}`)).toHaveCount(1);
  const pixels = async () =>
    page.evaluate(async () => {
      const svg = (
        document.getElementById("canvas") as unknown as SVGSVGElement
      ).cloneNode(true) as SVGSVGElement;
      svg.removeAttribute("style");
      svg.setAttribute("viewBox", "0 0 400 400");
      svg.setAttribute("width", "400");
      svg.setAttribute("height", "400");
      svg.querySelector("#cursors")?.remove();
      const url = URL.createObjectURL(
        new Blob([new XMLSerializer().serializeToString(svg)], {
          type: "image/svg+xml",
        }),
      );
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 400;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No canvas");
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      return [
        [180, 200],
        [250, 260],
        [350, 200],
        [140, 200],
      ].map(([x, y]) =>
        Array.from(ctx.getImageData(x ?? 0, y ?? 0, 1, 1).data),
      );
    });
  expect(await pixels()).toEqual([
    [255, 0, 0, 255],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 255],
  ]);
  await server.waitForStoredBoard(
    server.dataPath,
    name,
    (board) => board[id]?.kind === "bucket",
  );
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.boardPhase === "ready",
  );
  await boardPage.waitForBoardWritable();
  await scaleOne(page);
  expect(await pixels()).toEqual([
    [255, 0, 0, 255],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 255],
  ]);
  await boardPage.selectTool("eraser");
  await boardPage.selectTool("eraser");
  await page.evaluate(() => window.WBOApp.preferences.setSize(50));
  await tap(page, 180, 200);
  await expect(fill).toHaveAttribute("data-wbo-erasures", /size/);
  expect((await pixels())[0]).toEqual([0, 0, 0, 0]);
  await boardPage.selectTool("eraser");
  await tap(page, 180, 200);
  await expect(fill).toHaveCount(1);
  await tap(page, 180, 240);
  await expect(fill).toHaveCount(0);
  await expect(page.locator("#outline")).toHaveCount(1);
  await expect(page.locator("#island")).toHaveCount(1);
  await expect(peer.locator(`#${id}`)).toHaveCount(0);
});

test("bucket refuses open boundaries, partial-erasure gaps and blank space without saving paint", async ({
  boardPage,
  page,
  server,
}) => {
  const name = "bucket-gap";
  await server.writeBoard(server.dataPath, name, {
    outline: {
      id: "outline",
      tool: "rectangle",
      x: 14,
      y: 15,
      x2: 31,
      y2: 34,
      color: "#000000",
      size: 1,
    },
  });
  await boardPage.gotoBoard(name);
  await scaleOne(page);
  await boardPage.waitForBoardWritable();
  await boardPage.selectTool("eraser");
  await boardPage.selectTool("eraser");
  await page.evaluate(() => window.WBOApp.preferences.setSize(30));
  await tap(page, 220, 150);
  await expect(page.locator("#outline")).toHaveAttribute(
    "data-wbo-erasures",
    /size/,
  );
  await boardPage.selectTool("bucket");
  await tap(page, 180, 200);
  await expect(page.getByRole("alertdialog")).toContainText(
    "open or extends beyond",
  );
  await expect(page.locator("#drawingArea polygon")).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await tap(page, 350, 450);
  await expect(page.getByRole("alertdialog")).toContainText(
    "open or extends beyond",
  );
  await expect(page.locator("#drawingArea polygon")).toHaveCount(0);
});

test("painting controls fit narrow and RTL viewports and use localized labels", async ({
  boardPage,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await boardPage.gotoBoard("painting-rtl", { lang: "ar" });
  await scaleOne(page);
  await boardPage.selectTool("pencil");
  const panel = page.locator("#brushPalette");
  await expect(panel).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(390);
  await page.locator('[data-brush="graphite"]').click();
  await expect(panel).toBeHidden();
  await page.locator("#styleSummary").click();
  await page.locator("#paletteEdit").click();
  const style = await page.locator("#stylePanel").boundingBox();
  expect((style?.x || 0) + (style?.width || 0)).toBeLessThanOrEqual(390);
  await expect(page.locator("#paletteAdd")).toHaveAttribute(
    "aria-label",
    "إضافة لون",
  );
  await expect(page.locator("#toolID-bucket")).toHaveAttribute(
    "aria-label",
    "دلو التعبئة",
  );
});

test("bucket handles a large enclosure at the default zoom and keeps fills separate", async ({
  boardPage,
  page,
  server,
}) => {
  await server.writeBoard(server.dataPath, "bucket-default-zoom", {
    first: {
      id: "first",
      tool: "rectangle",
      x: 120,
      y: 140,
      x2: 320,
      y2: 350,
      color: "#000000",
      size: 2,
    },
    second: {
      id: "second",
      tool: "rectangle",
      x: 130,
      y: 400,
      x2: 300,
      y2: 550,
      color: "#000000",
      size: 2,
    },
  });
  await boardPage.gotoBoard("bucket-default-zoom");
  await boardPage.waitForBoardWritable();
  await boardPage.selectTool("bucket");
  await tap(page, 2000, 2000);
  const fills = page.locator('#drawingArea polygon[data-wbo-paint="bucket"]');
  await expect(fills).toHaveCount(1);
  await page.evaluate(() => window.WBOApp.preferences.setColor("#00ff00"));
  await tap(page, 2000, 4500);
  await expect(fills).toHaveCount(2);
  await boardPage.selectTool("eraser");
  await tap(page, 2000, 2000);
  await expect(fills).toHaveCount(1);
  await expect(fills).toHaveAttribute("fill", "#00ff00");
  await expect(page.locator("#first")).toHaveCount(1);
  await expect(page.locator("#second")).toHaveCount(1);
});

test("color panel closes on tool switches and outside taps while its controls stay interactive", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("palette-dismiss");
  await scaleOne(page);
  const summary = page.locator("#styleSummary");
  const panel = page.locator("#stylePanel");
  const activate = async (selector: string) => {
    const element = page.locator(selector);
    if (await page.evaluate(() => navigator.maxTouchPoints > 0))
      await element.tap();
    else await element.click();
  };
  await activate("#styleSummary");
  await expect(panel).toBeVisible();
  await page.evaluate(() => window.WBOApp.preferences.setColor("#345678"));
  await activate("#paletteAdd");
  await expect(panel).toBeVisible();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await activate("#toolID-pencil");
  await expect(panel).toBeHidden();
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#brushPalette")).toBeVisible();
  await activate("#styleSummary");
  await expect(panel).toBeVisible();
  await expect(page.locator("#brushPalette")).toBeHidden();
  // Reopening the current pen's chooser must dismiss the color popover too.
  await page.keyboard.press("p");
  await expect(panel).toBeHidden();
  await expect(page.locator("#brushPalette")).toBeVisible();
  await activate("#styleSummary");
  await expect(panel).toBeVisible();
  await page.keyboard.press("e");
  await boardPage.expectCurrentTool("eraser");
  await expect(panel).toBeHidden();
  await activate("#styleSummary");
  await page.evaluate(() => window.WBOApp.toolRegistry.activateTool("hand"));
  await expect(panel).toBeHidden();
  await activate("#styleSummary");
  await expect(panel).toBeVisible();
  if (await page.evaluate(() => navigator.maxTouchPoints > 0))
    await page.touchscreen.tap(370, 200);
  else await page.mouse.click(370, 200);
  await expect(panel).toBeHidden();
  await activate("#styleSummary");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("added colors scroll independently without pushing SIZE and Opacity down", async ({
  boardPage,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() =>
    localStorage.setItem(
      "wbo.customPalette",
      JSON.stringify(
        Array.from(
          { length: 24 },
          (_, i) => `#${(0x100000 + i * 137).toString(16)}`,
        ),
      ),
    ),
  );
  await boardPage.gotoBoard("palette-scroll");
  await scaleOne(page);
  await page.locator("#styleSummary").click();
  const palette = page.locator("#colorPresetSel");
  const measure = () =>
    page.evaluate(() => {
      const panel = document.getElementById("stylePanel") as HTMLElement;
      const colors = document.getElementById("colorPresetSel") as HTMLElement;
      const size = document.getElementById("chooseSize") as HTMLElement;
      const opacity = document.getElementById("chooseOpacity") as HTMLElement;
      return {
        height: panel.getBoundingClientRect().height,
        top: panel.getBoundingClientRect().top,
        panelOverflow: panel.scrollHeight - panel.clientHeight,
        paletteHeight: colors.clientHeight,
        paletteOverflow: colors.scrollHeight - colors.clientHeight,
        sizeTop: size.getBoundingClientRect().top,
        opacityTop: opacity.getBoundingClientRect().top,
      };
    });
  const before = await measure();
  for (let i = 0; i < 8; i++) {
    await page.evaluate(
      (i) =>
        window.WBOApp.preferences.setColor(`#${(0xabcdef + i).toString(16)}`),
      i,
    );
    await page.locator("#paletteAdd").click();
  }
  await expect(page.locator("[data-custom-color]")).toHaveCount(32);
  const after = await measure();
  expect(after.paletteOverflow).toBeGreaterThan(0);
  expect(after.paletteHeight).toBeLessThanOrEqual(184);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.sizeTop - before.sizeTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.opacityTop - before.opacityTop)).toBeLessThanOrEqual(1);
  expect(after.panelOverflow).toBeLessThanOrEqual(1);
  await palette.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await palette.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const scrolled = await measure();
  expect(Math.abs(scrolled.sizeTop - after.sizeTop)).toBeLessThanOrEqual(1);
  await expect(page.locator("#chooseOpacity")).toBeInViewport();
  await page.locator("#paletteEdit").click();
  const rows = page.locator(".palette-editor-rows");
  expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  );
  await expect
    .poll(async () => {
      const m = await measure();
      return m.top + m.height;
    })
    .toBeLessThanOrEqual(836);
  await page.screenshot({
    path: testInfo.outputPath("scrolling-color-palette.png"),
  });
});

for (const kind of ["graphite", "marker", "brush"])
  test(`${kind} keeps same stroke overlaps painted before release, on peers and after reload`, async ({
    boardPage,
    page,
    context,
    server,
  }) => {
    const name = `overlap-${kind}`;
    await boardPage.gotoBoard(name);
    await scaleOne(page);
    await boardPage.waitForBoardWritable();
    const peer = await context.newPage();
    await createBoardPage(peer, server).gotoBoard(name);
    await boardPage.selectTool("pencil");
    await page.locator(`[data-brush="${kind}"]`).click();
    await expect(page.locator(`[data-brush="${kind}"]`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.evaluate(() => {
      window.WBOApp.preferences.setSize(60);
      window.WBOApp.preferences.setColor("#ff0000");
    });
    async function coverage(target: Page) {
      return target.evaluate(async () => {
        const original = document.getElementById(
          "canvas",
        ) as unknown as SVGSVGElement;
        const svg = original.cloneNode(true) as SVGSVGElement;
        svg.removeAttribute("style");
        svg.setAttribute("viewBox", "0 0 400 500");
        svg.setAttribute("width", "400");
        svg.setAttribute("height", "500");
        svg.querySelector("#cursors")?.remove();
        const url = URL.createObjectURL(
          new Blob([new XMLSerializer().serializeToString(svg)], {
            type: "image/svg+xml",
          }),
        );
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 500;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Missing raster context");
        ctx.drawImage(image, 0, 0);
        URL.revokeObjectURL(url);
        return [
          [220, 400],
          [220, 320],
        ].map(([x, y]) => {
          const pixels = ctx.getImageData(
            (x ?? 0) - 4,
            (y ?? 0) - 4,
            9,
            9,
          ).data;
          let painted = 0;
          for (let i = 3; i < pixels.length; i += 4)
            if ((pixels[i] ?? 0) > 20) painted++;
          return painted / 81;
        });
      });
    }
    const start = await point(page, 140, 400);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const [x, y] of [
      [300, 400],
      [140, 400],
      [300, 240],
      [140, 240],
      [300, 400],
    ]) {
      const next = await point(page, x ?? 0, y ?? 0);
      await page.mouse.move(next.x, next.y, { steps: 16 });
    }
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    for (const c of await coverage(page)) expect(c).toBeGreaterThan(0.3);
    await page.mouse.up();
    const painted = page.locator(
      `#drawingArea polygon[data-wbo-paint="${kind}"]`,
    );
    await expect(painted).toHaveCount(1);
    await expect(painted).toHaveAttribute("fill-rule", "nonzero");
    const id = await painted.getAttribute("id");
    if (!id) throw new Error("No committed stroke");
    await expect(peer.locator(`#${id}`)).toHaveAttribute(
      "fill-rule",
      "nonzero",
    );
    for (const c of await coverage(page)) expect(c).toBeGreaterThan(0.3);
    for (const c of await coverage(peer)) expect(c).toBeGreaterThan(0.3);
    await server.waitForStoredBoard(
      server.dataPath,
      name,
      (board) => board[id]?.paintRule === "nonzero",
    );
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.dataset.boardPhase === "ready",
    );
    await boardPage.waitForBoardWritable();
    for (const c of await coverage(page)) expect(c).toBeGreaterThan(0.3);
  });
