import { createBoardPage, expect, test } from "../fixtures/test";

test("partial erasing uses SIZE, stays transparent, syncs and survives reload", async ({
  boardPage,
  page,
  server,
  context,
}) => {
  const name = "partial-eraser-persist";
  await server.writeBoard(server.dataPath, name, {
    stroke: {
      id: "stroke",
      tool: "pencil",
      color: "#ff0000",
      size: 40,
      _children: [
        { x: 200, y: 200 },
        { x: 700, y: 200 },
      ],
    },
  });
  await boardPage.gotoBoard(name, { lang: "ja" });
  const peer = await context.newPage();
  await createBoardPage(peer, server).gotoBoard(name);
  await boardPage.selectTool("eraser");
  await boardPage.selectTool("eraser");
  await expect(page.locator("html")).toHaveAttribute(
    "data-active-tool-mode",
    "partial_eraser",
  );
  await page.evaluate(() => window.WBOApp.preferences.setSize(60));
  const point = await page.evaluate(() => {
    const svg = document.getElementById("canvas") as unknown as SVGSVGElement;
    const matrix = svg.getScreenCTM();
    if (!matrix) throw new Error("Missing SVG screen transform");
    const p = new DOMPoint(3000, 2000).matrixTransform(matrix);
    return { x: p.x, y: p.y };
  });
  if (
    context.browser()?.browserType().name() === "chromium" &&
    (await page.evaluate(() => navigator.maxTouchPoints > 0))
  )
    await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  const path = page.locator("#drawingArea #stroke");
  await expect(path).toHaveAttribute("data-wbo-erasures", /"size":60/);
  expect(
    JSON.parse((await path.getAttribute("data-wbo-erasures")) || "[]")[0],
  ).toMatchObject({ x: 3000, y: 2000, size: 60 });
  await expect(peer.locator("#drawingArea #stroke")).toHaveAttribute(
    "data-wbo-erasures",
    /"size":60/,
  );
  await expect(page.locator("#drawingArea path")).toHaveCount(1);
  // Render the actual exported SVG: the erased area must have alpha zero,
  // while both surviving halves retain red pixels.
  async function pixels() {
    return page.evaluate(async () => {
      const svg = (
        document.getElementById("canvas") as unknown as SVGSVGElement
      ).cloneNode(true) as SVGSVGElement;
      svg.removeAttribute("style");
      svg.setAttribute("viewBox", "0 0 8000 3000");
      svg.setAttribute("width", "800");
      svg.setAttribute("height", "300");
      const url = URL.createObjectURL(
        new Blob([new XMLSerializer().serializeToString(svg)], {
          type: "image/svg+xml",
        }),
      );
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 300;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Missing canvas context");
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      return [250, 299, 300, 301, 500].map((x) =>
        Array.from(ctx.getImageData(x, 200, 1, 1).data),
      );
    });
  }
  expect(await pixels()).toEqual([
    [255, 0, 0, 255],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [255, 0, 0, 255],
  ]);
  await server.waitForStoredBoard(
    server.dataPath,
    name,
    (board) => !!(board.stroke as any)?.erasures?.length,
  );
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.boardPhase === "ready",
  );
  await boardPage.waitForBoardWritable();
  await expect(path).toHaveAttribute("data-wbo-erasures", /"size":60/);
  expect(await pixels()).toEqual([
    [255, 0, 0, 255],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [255, 0, 0, 255],
  ]);
  await page.evaluate(() =>
    document.querySelector('defs[data-wbo-eraser-defs="true"]')?.remove(),
  );
  await boardPage.forceSocketDisconnect();
  await boardPage.waitForAuthoritativeResync();
  await expect(
    page.locator('defs[data-wbo-eraser-defs="true"] mask'),
  ).toHaveCount(1);
  expect(await pixels()).toEqual([
    [255, 0, 0, 255],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [255, 0, 0, 255],
  ]);
  await boardPage.selectTool("eraser");
  await page.mouse.click(point.x - 50, point.y);
  await expect(path).toHaveCount(0);
  await expect(peer.locator("#drawingArea #stroke")).toHaveCount(0);
  await peer.close();
});

test("selecting the pen again keeps normal ink and SIZE", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("pencil-without-whiteout");
  await page.evaluate(() => {
    window.WBOApp.preferences.setSize(40);
    window.WBOApp.preferences.setColor("#123456");
  });
  await boardPage.selectTool("pencil");
  await boardPage.selectTool("pencil");
  await expect(page.locator("html")).toHaveAttribute(
    "data-active-tool-secondary",
    "false",
  );
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(320, 220);
  await page.mouse.up();
  await expect(page.locator("#drawingArea path")).toHaveAttribute(
    "stroke",
    "#123456",
  );
  await expect(page.locator("#drawingArea path")).toHaveAttribute(
    "stroke-width",
    "40",
  );
});

test("a partial eraser drag reaches overlapping objects and copies keep their own masks", async ({
  boardPage,
  page,
  server,
}) => {
  const name = "partial-eraser-drag";
  await server.writeBoard(server.dataPath, name, {
    p: {
      id: "p",
      tool: "pencil",
      color: "#ff0000",
      size: 10,
      _children: [
        { x: 200, y: 200 },
        { x: 700, y: 200 },
      ],
    },
    r: {
      id: "r",
      tool: "rectangle",
      color: "#000000",
      size: 4,
      x: 250,
      y: 180,
      x2: 350,
      y2: 220,
    },
  });
  await boardPage.gotoBoard(name);
  await boardPage.selectTool("eraser");
  await boardPage.selectTool("eraser");
  await page.evaluate(() => window.WBOApp.preferences.setSize(100));
  const points = await page.evaluate(() => {
    const svg = document.getElementById("canvas") as unknown as SVGSVGElement;
    const m = svg.getScreenCTM();
    if (!m) throw new Error("Missing screen transform");
    return [new DOMPoint(3000, 1700), new DOMPoint(3000, 2300)].map((p) => {
      const q = p.matrixTransform(m);
      return { x: q.x, y: q.y };
    });
  });
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 8 });
  await page.mouse.up();
  for (const id of ["p", "r"])
    await expect(page.locator(`#drawingArea #${id}`)).toHaveAttribute(
      "data-wbo-erasures",
      /"size":100/,
    );
  await boardPage.waitForBufferedWritesDrained();
  await boardPage.selectTool("hand");
  await page.evaluate(() => {
    window.WBOApp.writes.drawAndSend({
      tool: 7,
      _children: [
        { type: 7, id: "p", newid: "copy" },
        {
          type: 2,
          id: "copy",
          transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 500 },
        },
      ],
    });
  });
  await boardPage.waitForBufferedWritesDrained();
  const originalMask = await page
    .locator("#drawingArea #p")
    .getAttribute("mask");
  const copyMask = await page
    .locator("#drawingArea #copy")
    .getAttribute("mask");
  expect(copyMask).toBeTruthy();
  expect(copyMask).not.toBe(originalMask);
  await boardPage.selectTool("eraser");
  await page.evaluate(() =>
    window.WBOApp.writes.drawAndSend({ tool: 6, type: 3, id: "p" }),
  );
  await expect(page.locator("#drawingArea #p")).toHaveCount(0);
  await expect(page.locator("#drawingArea #copy")).toHaveAttribute(
    "mask",
    copyMask || "",
  );
  await expect(
    page.locator('defs[data-wbo-eraser-defs="true"] mask'),
  ).toHaveCount(2);
  await server.waitForStoredBoard(
    server.dataPath,
    name,
    (board) =>
      !board.p && !!board.copy?.erasures?.length && !!board.r?.erasures?.length,
  );
});
