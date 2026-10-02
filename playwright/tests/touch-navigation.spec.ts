import { expect, test } from "../fixtures/test";

test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

test("touch palette exposes every color without expanding another tool", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("touch-palette");
  await boardPage.waitForSocketConnected();
  const summary = page.locator("#styleSummary");
  const panel = page.locator("#stylePanel");
  const colors = panel.locator(".colorPresetButton");
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 320, height: 240 },
  ]) {
    await page.setViewportSize(viewport);
    for (const expandZoom of [false, true]) {
      if (expandZoom) await boardPage.tool("zoom").tap();
      await summary.tap();
      await expect(summary).toHaveAttribute("aria-expanded", "true");
      await expect(panel).toBeVisible();
      await expect(colors).toHaveCount(12);
      for (let index = 0; index < 12; index++) {
        const color = colors.nth(index);
        await color.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            color.evaluate((button) => {
              const rect = button.getBoundingClientRect();
              const hit = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
              return !!hit && button.contains(hit);
            }),
          )
          .toBe(true);
        if (index < 11) {
          await color.tap();
          await expect(color).toHaveAttribute("aria-pressed", "true");
        }
      }
      await page.locator("#chooseOpacity").scrollIntoViewIfNeeded();
      await expect(page.locator("#chooseOpacity")).toBeInViewport();
      await summary.tap();
      await expect(panel).toBeHidden();
    }
  }
});

test("pinch keeps its midpoint anchored through repeated zooms and finger release", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("touch-pinch-anchor");
  await boardPage.selectTool("pencil");
  await boardPage.selectTool("hand");
  await expect
    .poll(() => boardPage.readActiveToolState())
    .toMatchObject({ secondary: false });
  const result = await page.evaluate(async () => {
    const viewport = window.WBOApp.viewportState.controller;
    const board = document.getElementById("board");
    if (!board) throw new Error("Missing board");
    viewport.ensureBoardExtentForPoint(100000, 100000);
    viewport.setScale(0.2);
    viewport.panTo(800, 600);
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await frame();
    type Finger = { identifier: number; clientX: number; clientY: number };
    const dispatch = (
      type: string,
      fingers: Finger[],
      changed: Finger[] = fingers,
    ) => {
      const toTouch = (finger: Finger) => ({
        ...finger,
        target: board,
        pageX: window.scrollX + finger.clientX,
        pageY: window.scrollY + finger.clientY,
      });
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: fingers.map(toTouch) },
        targetTouches: { value: fingers.map(toTouch) },
        changedTouches: { value: changed.map(toTouch) },
      });
      board.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const fingers = (distance: number, x = 500, y = 350): Finger[] => [
      { identifier: 1, clientX: x - distance / 2, clientY: y },
      { identifier: 2, clientX: x + distance / 2, clientY: y },
    ];
    const first = fingers(120);
    const initial = viewport.clientRectToBoardRect({ left: 500, top: 350 });
    const prevented = [dispatch("touchstart", [first[0]], [first[0]])];
    prevented.push(dispatch("touchstart", first, [first[1]]));
    const errors: number[] = [];
    for (const distance of [150, 240, 360, 240, 120, 90, 60, 90, 120]) {
      prevented.push(dispatch("touchmove", fingers(distance)));
      await frame();
      const location = viewport.boardRectToViewportRect({
        x: initial.x,
        y: initial.y,
        width: 0,
        height: 0,
      });
      errors.push(Math.hypot(location.left - 500, location.top - 350));
    }
    const beforeExtra = {
      x: window.scrollX,
      y: window.scrollY,
      scale: viewport.getScale(),
    };
    const third = { identifier: 3, clientX: 900, clientY: 650 };
    prevented.push(dispatch("touchstart", [third, ...first], [third]));
    prevented.push(dispatch("touchmove", [third, ...first]));
    await frame();
    const afterExtra = {
      x: window.scrollX,
      y: window.scrollY,
      scale: viewport.getScale(),
    };
    dispatch("touchend", first, [third]);
    prevented.push(dispatch("touchmove", fingers(120, 540, 380)));
    await frame();
    const moved = viewport.boardRectToViewportRect({
      x: initial.x,
      y: initial.y,
      width: 0,
      height: 0,
    });
    const last = fingers(120, 540, 380);
    dispatch("touchend", [last[0]], [last[1]]);
    const beforeRelease = {
      x: window.scrollX,
      y: window.scrollY,
      scale: viewport.getScale(),
    };
    dispatch("touchmove", [{ ...last[0], clientX: 400 }]);
    dispatch("touchend", [], [{ ...last[0], clientX: 400 }]);
    await frame();
    const afterRelease = {
      x: window.scrollX,
      y: window.scrollY,
      scale: viewport.getScale(),
    };
    return {
      prevented,
      errors,
      beforeExtra,
      afterExtra,
      moved,
      beforeRelease,
      afterRelease,
      touchAction: getComputedStyle(board).touchAction,
    };
  });
  expect(result.touchAction).toBe("none");
  expect(result.prevented.every(Boolean)).toBe(true);
  expect(Math.max(...result.errors)).toBeLessThanOrEqual(2);
  expect(result.afterExtra).toEqual(result.beforeExtra);
  expect(result.moved.left).toBeCloseTo(540, 0);
  expect(result.moved.top).toBeCloseTo(380, 0);
  expect(result.afterRelease).toEqual(result.beforeRelease);
});

test("native touch events pan with one finger and zoom around the same point", async ({
  boardPage,
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "CDP touch input requires Chromium.");
  await boardPage.gotoBoard("native-touch-pinch");
  await boardPage.selectTool("pencil");
  await boardPage.selectTool("hand");
  await expect
    .poll(() => boardPage.readActiveToolState())
    .toMatchObject({ secondary: false });
  await page.evaluate(() => {
    const viewport = window.WBOApp.viewportState.controller;
    viewport.ensureBoardExtentForPoint(100000, 100000);
    viewport.setScale(0.2);
    viewport.panTo(800, 600);
  });
  const session = await page.context().newCDPSession(page);
  const send = (type: string, points: { x: number; y: number; id: number }[]) =>
    session.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  await send("touchStart", [{ x: 440, y: 350, id: 1 }]);
  await send("touchMove", [{ x: 460, y: 370, id: 1 }]);
  await expect
    .poll(() => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })))
    .toEqual({ x: 780, y: 580 });
  const anchor = await page.evaluate(() =>
    window.WBOApp.viewportState.controller.clientRectToBoardRect({
      left: 520,
      top: 370,
    }),
  );
  await send("touchStart", [
    { x: 460, y: 370, id: 1 },
    { x: 580, y: 370, id: 2 },
  ]);
  for (const distance of [150, 240, 360, 120, 90, 60, 120]) {
    await send("touchMove", [
      { x: 520 - distance / 2, y: 370, id: 1 },
      { x: 520 + distance / 2, y: 370, id: 2 },
    ]);
    await expect
      .poll(() =>
        page.evaluate(({ x, y }) => {
          const viewport = window.WBOApp.viewportState.controller;
          const rect = viewport.boardRectToViewportRect({
            x,
            y,
            width: 0,
            height: 0,
          });
          return Math.hypot(rect.left - 520, rect.top - 370);
        }, anchor),
      )
      .toBeLessThanOrEqual(2);
    await expect
      .poll(() =>
        page.evaluate(() => window.WBOApp.viewportState.controller.getScale()),
      )
      .toBeCloseTo((0.2 * distance) / 120, 5);
  }
  await send("touchEnd", [{ x: 460, y: 370, id: 1 }]);
  const before = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    scale: window.WBOApp.viewportState.controller.getScale(),
  }));
  await send("touchMove", [{ x: 400, y: 340, id: 1 }]);
  await send("touchEnd", []);
  expect(
    await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
      scale: window.WBOApp.viewportState.controller.getScale(),
    })),
  ).toEqual(before);
  await session.detach();
});

test("phone pinch batches rapid input without oscillating around its anchor", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("phone-pinch-frames");
  await boardPage.selectTool("pencil");
  await boardPage.selectTool("hand");
  for (const size of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(size);
    const result = await page.evaluate(async () => {
      const viewport = window.WBOApp.viewportState.controller;
      const board = document.getElementById("board");
      if (!board) throw new Error("Missing board");
      const frame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      viewport.ensureBoardExtentForPoint(100000, 100000);
      viewport.setScale(0.2);
      viewport.panTo(1600, 1600);
      await frame();
      const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      const anchor = viewport.clientRectToBoardRect({
        left: center.x,
        top: center.y,
      });
      const dispatch = (type: string, distance: number) => {
        const touches = [
          {
            identifier: 1,
            clientX: center.x - distance / 2,
            clientY: center.y,
          },
          {
            identifier: 2,
            clientX: center.x + distance / 2,
            clientY: center.y,
          },
        ];
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches },
          targetTouches: { value: touches },
          changedTouches: { value: touches },
        });
        board.dispatchEvent(event);
      };
      dispatch("touchstart", 64);
      let paints = 0;
      const countPaint = () => paints++;
      board.addEventListener("wbo:viewport-layout", countPaint);
      const errors: number[] = [];
      const scales: number[] = [];
      const frames = [80, 112, 160, 240, 160, 112, 64, 40, 24, 40, 64];
      for (const distance of frames) {
        for (const sample of [distance - 2, distance - 1, distance]) {
          dispatch("touchmove", sample);
        }
        await frame();
        const rect = viewport.boardRectToViewportRect({
          ...anchor,
          width: 0,
          height: 0,
        });
        errors.push(Math.hypot(rect.left - center.x, rect.top - center.y));
        scales.push(viewport.getScale());
      }
      // A release before the next frame must preserve the final valid sample.
      dispatch("touchmove", 96);
      const release = new Event("touchend", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperties(release, {
        touches: { value: [] },
        changedTouches: { value: [] },
      });
      board.dispatchEvent(release);
      const finalScale = viewport.getScale();
      await frame();
      board.removeEventListener("wbo:viewport-layout", countPaint);
      return {
        errors,
        scales,
        frames,
        paints,
        finalScale,
        afterRelease: viewport.getScale(),
      };
    });
    expect(Math.max(...result.errors)).toBeLessThanOrEqual(2);
    expect(result.scales).toEqual(
      result.frames.map((distance) => (0.2 * distance) / 64),
    );
    expect(result.paints).toBe(result.frames.length + 1);
    expect(result.finalScale).toBeCloseTo(0.3, 8);
    expect(result.afterRelease).toBe(result.finalScale);
  }
});
