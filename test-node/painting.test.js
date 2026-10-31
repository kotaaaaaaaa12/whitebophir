import assert from "node:assert/strict";
import { test } from "node:test";
import { floodPolygon } from "../client-data/tools/bucket/flood.js";
import {
  polygonBounds,
  polygonFromContours,
  strokePolygon,
  MAX_STROKE_SAMPLES,
  paintFillRule,
} from "../client-data/tools/paint/geometry.js";
import { normalizePalette } from "../client-data/js/paint_controls.js";
import { normalizeIncomingMessage } from "../server/socket/message_validation.mjs";
import {
  parseStoredSvgItem,
  serializeStoredSvgItem,
  summarizeStoredSvgItem,
} from "../server/persistence/stored_svg_item_codec.mjs";
import { parseStoredSvgItems } from "../server/persistence/svg_envelope.mjs";
import { readFileSync } from "node:fs";

const config = { MAX_BOARD_SIZE: 655360, MAX_CHILDREN: 192 };
/** @param {string} points @param {string} [kind] */
function paint(points, kind = "bucket") {
  return {
    tool: 13,
    type: 1,
    id: "test-paint",
    points,
    kind,
    color: "#123456",
    size: 40,
    opacity: 0.5,
    ...polygonBounds(points),
  };
}
/** @param {string} points @param {number} x @param {number} y */
function contains(points, x, y) {
  const values = points.split(/[ ,]+/).map(Number);
  let hit = false;
  for (let i = 0, j = values.length - 2; i < values.length; j = i, i += 2) {
    const ax = values[i] ?? 0,
      ay = values[i + 1] ?? 0,
      bx = values[j] ?? 0,
      by = values[j + 1] ?? 0;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax)
      hit = !hit;
  }
  return hit;
}
function image() {
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  const black = (/** @type {number} */ x, /** @type {number} */ y) => {
    pixels[(y * 32 + x) * 4 + 3] = 255;
  };
  for (let i = 4; i <= 27; i++) {
    black(i, 4);
    black(i, 27);
    black(4, i);
    black(27, i);
  }
  return { pixels, black };
}

test("closed fills preserve interior islands and use one even-odd object", () => {
  const { pixels, black } = image();
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) black(x, y);
  const points = floodPolygon(pixels, 32, 32, 8, 8);
  assert.equal(contains(points, 8.5, 8.5), true);
  assert.equal(contains(points, 15.5, 15.5), false);
  assert.equal(contains(points, 2, 2), false);
  assert.deepEqual(polygonBounds(points), { x: 5, y: 5, x2: 27, y2: 27 });
});
for (const [x, y] of [
  [4, 16],
  [27, 16],
  [16, 4],
  [16, 27],
])
  test(`a one-pixel gap at ${x},${y} rejects without producing paint`, () => {
    const { pixels } = image();
    pixels[((y ?? 0) * 32 + (x ?? 0)) * 4 + 3] = 0;
    assert.throws(() => floodPolygon(pixels, 32, 32, 8, 8), /bucket_open/);
  });
test("an unbounded blank board is rejected", () => {
  assert.throws(
    () => floodPolygon(new Uint8ClampedArray(32 * 32 * 4), 32, 32, 16, 16),
    /bucket_open/,
  );
});
test("a fill over existing color follows the composited target", () => {
  const { pixels } = image();
  for (let y = 5; y < 27; y++)
    for (let x = 5; x < 27; x++) {
      pixels[(y * 32 + x) * 4] = 255;
      pixels[(y * 32 + x) * 4 + 3] = 160;
    }
  const result = floodPolygon(pixels, 32, 32, 8, 8, 100, 200);
  assert.equal(contains(result, 108, 208), true);
  assert.deepEqual(polygonBounds(result), { x: 105, y: 205, x2: 127, y2: 227 });
});
test("paint admission rejects forged bounds, markup, oversized polygons and kinds", () => {
  const good = paint("10,10 30,10 30,30 10,30");
  assert.equal(normalizeIncomingMessage(config, good).ok, true);
  for (const bad of [
    { ...good, x: 0 },
    { ...good, points: '0,0 10,0 1,1" onload="alert(1)' },
    { ...good, points: "0,0 ".repeat(13000) },
    { ...good, kind: "unknown" },
    { ...good, points: "-1,0 0,10 10,0" },
  ])
    assert.equal(normalizeIncomingMessage(config, bad).ok, false);
});
test("paint survives summary, serialization, transform and erasure metadata", () => {
  const item = {
    ...paint("10,10 30,10 30,30 10,30"),
    tool: "paint",
    transform: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 6 },
  };
  const svg = serializeStoredSvgItem(item);
  assert.equal(parseStoredSvgItems(svg).length, 1);
  const rawAttributes = svg.slice("<polygon".length, svg.indexOf(">"));
  const entry = { tagName: "polygon", rawAttributes };
  const summary = summarizeStoredSvgItem(entry, 3);
  assert.equal(summary.tool, "paint");
  assert.equal(summary.paintOrder, 3);
  const parsed = parseStoredSvgItem(entry);
  assert.equal(parsed.points, item.points);
  assert.equal(parsed.kind, "bucket");
  assert.equal(parsed.size, 40);
  assert.equal(parsed.opacity, 0.5);
  assert.deepEqual(parsed.transform, item.transform);
  assert.equal(svg.includes('fill-rule="evenodd"'), true);
});
test("doubled bridges do not fill holes or paint connecting triangles", () => {
  const points = polygonFromContours([
    [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ],
    [
      [5, 5],
      [10, 5],
      [10, 10],
      [5, 10],
    ],
  ]);
  assert.equal(contains(points, 2, 2), true);
  assert.equal(contains(points, 7, 7), false);
  assert.equal(contains(points, 30, 30), false);
});
test("all brush silhouettes are deterministic and valid stored polygons", () => {
  const samples = [
    { x: 100, y: 100, width: 30 },
    { x: 130, y: 110, width: 20 },
    { x: 160, y: 105, width: 10 },
  ];
  for (const kind of ["graphite", "marker", "brush"]) {
    const a = strokePolygon(samples, kind);
    assert.equal(a, strokePolygon(samples, kind));
    assert.equal(normalizeIncomingMessage(config, paint(a, kind)).ok, true);
    let ink = 0;
    for (let y = 105; y < 115; y++)
      for (let x = 125; x < 135; x++)
        if (winding(a, x + 0.5, y + 0.5) !== 0) ink++;
    assert.ok(ink > 30, `${kind} should paint visible ink`);
  }
  assert.ok(strokePolygon([{ x: 10, y: 10, width: 20 }], "marker"));
});
test("custom palettes sanitize malformed storage, duplicates and excessive colors", () => {
  assert.deepEqual(
    normalizePalette(["#AbCdEf", "bad", "#abcdef", null, "#123456"]),
    ["#abcdef", "#123456"],
  );
  assert.deepEqual(normalizePalette({}), []);
  assert.equal(
    normalizePalette(
      Array.from(
        { length: 100 },
        (_, i) => `#${i.toString(16).padStart(6, "0")}`,
      ),
    ).length,
    64,
  );
});
test("every supported language includes all painting controls and failures", () => {
  const dictionaries = JSON.parse(
    readFileSync(
      new URL("../server/http/translations.json", import.meta.url),
      "utf8",
    ),
  );
  const keys = [
    "pen_palette",
    "brush_pen",
    "brush_graphite",
    "brush_marker",
    "brush_brush",
    "palette_add",
    "palette_edit",
    "palette_hex",
    "palette_remove",
    "palette_earlier",
    "palette_later",
    "palette_invalid",
    "palette_full",
    "palette_failed",
    "bucket",
    "bucket_help",
    "bucket_open",
    "bucket_empty",
    "bucket_failed",
    "paint_too_complex",
    "paint_close",
  ];
  assert.equal(Object.keys(dictionaries).length, 21);
  for (const [lang, strings] of Object.entries(dictionaries))
    for (const key of keys) assert.ok(strings[key], `${lang}: ${key}`);
});

/** @type {Map<string,number[]>} */
const windingCoordinates = new Map();
/** @param {string} points @param {number} x @param {number} y */
function winding(points, x, y) {
  let v = windingCoordinates.get(points);
  if (!v) {
    v = points.split(/[ ,]+/).map(Number);
    windingCoordinates.set(points, v);
  }
  let count = 0;
  for (let i = 0, j = v.length - 2; i < v.length; j = i, i += 2) {
    const ax = v[j] ?? 0,
      ay = v[j + 1] ?? 0,
      bx = v[i] ?? 0,
      by = v[i + 1] ?? 0;
    const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y && by > y && side > 0) count++;
    if (ay > y && by <= y && side < 0) count--;
  }
  return count;
}

test("retraces and crossings keep ink under nonzero fill", () => {
  const retrace = [
    { x: 100, y: 100, width: 40 },
    { x: 250, y: 100, width: 40 },
    { x: 100, y: 100, width: 40 },
  ];
  const cross = [
    { x: 100, y: 100, width: 40 },
    { x: 250, y: 250, width: 40 },
    { x: 250, y: 100, width: 40 },
    { x: 100, y: 250, width: 40 },
  ];
  for (const kind of ["marker", "brush"]) {
    const back = strokePolygon(retrace, kind),
      overlap = strokePolygon(cross, kind);
    for (let x = 110; x < 240; x += 5)
      assert.ok(winding(back, x, 100) > 0, `${kind}: retrace at ${x}`);
    assert.ok(winding(overlap, 175, 175) > 0, `${kind}: crossing`);
  }
  const ring = strokePolygon(
    [
      { x: 100, y: 100, width: 20 },
      { x: 200, y: 100, width: 20 },
      { x: 200, y: 200, width: 20 },
      { x: 100, y: 200, width: 20 },
      { x: 100, y: 100, width: 20 },
    ],
    "marker",
  );
  assert.equal(winding(ring, 150, 150), 0);
  assert.ok(winding(ring, 100, 150) > 0);
});

test("graphite keeps transparent grain without canceling dense retraces", () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({
    x: i % 2 ? 250 : 100,
    y: 100,
    width: 40,
  }));
  const points = strokePolygon(samples, "graphite");
  let painted = 0,
    holes = 0;
  for (let y = 90; y < 110; y++)
    for (let x = 110; x < 240; x++) {
      const w = winding(points, x + 0.5, y + 0.5);
      if (w !== 0) painted++;
      else holes++;
    }
  assert.ok(painted > 1300);
  assert.ok(holes > 0);
  assert.equal(
    normalizeIncomingMessage(config, {
      ...paint(points, "graphite"),
      paintRule: "nonzero",
    }).ok,
    true,
  );
});

test("bounded long strokes remain within polygon admission limits", () => {
  const samples = Array.from({ length: MAX_STROKE_SAMPLES }, (_, i) => ({
    x: 100 + (i % 100) * 5,
    y: 100 + Math.floor(i / 100) * 30,
    width: 5 + (i % 35),
  }));
  for (const kind of ["marker", "brush", "graphite"]) {
    const points = strokePolygon(samples, kind);
    assert.equal(
      normalizeIncomingMessage(config, {
        ...paint(points, kind),
        paintRule: "nonzero",
      }).ok,
      true,
    );
    const far = strokePolygon(
      samples.map((p) => ({ ...p, x: p.x + 600000, y: p.y + 600000 })),
      kind,
    );
    assert.equal(
      normalizeIncomingMessage(config, {
        ...paint(far, kind),
        paintRule: "nonzero",
      }).ok,
      true,
    );
  }
});

test("fill rules survive storage while legacy and bucket holes stay even-odd", () => {
  const item = {
    ...paint("10,10 30,10 30,30 10,30", "marker"),
    tool: "paint",
    paintRule: "nonzero",
  };
  const svg = serializeStoredSvgItem(item),
    entries = parseStoredSvgItems(svg);
  assert.match(svg, /fill-rule="nonzero"/);
  assert.equal(
    parseStoredSvgItem(/** @type {any} */ (entries[0])).paintRule,
    "nonzero",
  );
  const legacy = serializeStoredSvgItem({ ...item, paintRule: undefined });
  assert.match(legacy, /fill-rule="evenodd"/);
  assert.equal(
    parseStoredSvgItem(/** @type {any} */ (parseStoredSvgItems(legacy)[0]))
      .paintRule,
    "evenodd",
  );
  assert.equal(paintFillRule(undefined), "evenodd");
  assert.equal(
    normalizeIncomingMessage(config, {
      ...paint(item.points, "marker"),
      paintRule: "nonzero",
    }).ok,
    true,
  );
  for (const rule of ["inherit", "url(#anything)", false, {}])
    assert.equal(
      normalizeIncomingMessage(config, {
        ...paint(item.points),
        paintRule: rule,
      }).ok,
      false,
    );
});
