/** @typedef {[number, number]} XY */
/** @typedef {{x:number,y:number,width:number}} Sample */
export const MAX_POLYGON_LENGTH = 180_000;
export const MAX_POLYGON_POINTS = 12_000;
export const PAINT_KINDS = ["graphite", "marker", "brush", "bucket"];

/** Parse only numeric polygon coordinates, never SVG markup or commands.
 * @param {unknown} points @param {number} [maxBoardSize]
 */
export function polygonBounds(points, maxBoardSize = 655360) {
  if (
    typeof points !== "string" ||
    points.length > MAX_POLYGON_LENGTH ||
    !/^[\d.,\s]+$/.test(points)
  )
    return null;
  const values = points
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    values.length < 6 ||
    values.length % 2 ||
    values.length > MAX_POLYGON_POINTS * 2
  )
    return null;
  let x = Infinity,
    y = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (let i = 0; i < values.length; i += 2) {
    const a = values[i],
      b = values[i + 1];
    if (
      typeof a !== "number" ||
      typeof b !== "number" ||
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < 0 ||
      b < 0 ||
      a > maxBoardSize ||
      b > maxBoardSize
    )
      return null;
    x = Math.min(x, a);
    y = Math.min(y, b);
    x2 = Math.max(x2, a);
    y2 = Math.max(y2, b);
  }
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    x2: Math.ceil(x2),
    y2: Math.ceil(y2),
  };
}

/** Stitch closed contours with doubled bridges; even-odd fill preserves holes.
 * @param {XY[][]} contours
 */
export function polygonFromContours(contours) {
  const origin = contours[0]?.[0];
  if (!origin) return "";
  const output = [origin];
  for (const contour of contours) {
    const first = contour[0];
    if (!first) continue;
    output.push(...contour, first, origin);
  }
  if (output.length > MAX_POLYGON_POINTS) throw new Error("paint_too_complex");
  const points = output
    .map(
      (p) =>
        `${Math.max(0, Math.round(p[0] * 100) / 100)},${Math.max(0, Math.round(p[1] * 100) / 100)}`,
    )
    .join(" ");
  if (points.length > MAX_POLYGON_LENGTH) throw new Error("paint_too_complex");
  return points;
}

/** @param {number} x @param {number} y @param {XY[]} outline */
function inside(x, y, outline) {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = /** @type {XY} */ (outline[i]),
      b = /** @type {XY} */ (outline[j]);
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit;
  }
  return hit;
}

/** @param {{x:number,y:number,width:number}[]} samples @param {string} kind */
export function strokePolygon(samples, kind) {
  const start = samples[0];
  if (!start) return "";
  /** @type {XY[]} */ const left = [];
  /** @type {XY[]} */ const right = [];
  for (let i = 0; i < samples.length; i++) {
    const p = /** @type {Sample} */ (samples[i]),
      prev = samples[Math.max(0, i - 1)] || start,
      next = samples[Math.min(samples.length - 1, i + 1)] || start;
    const angle = Math.atan2(next.y - prev.y, next.x - prev.x);
    const grain = kind === "graphite" ? 0.82 + ((i * 37) % 19) / 50 : 1;
    const radius = (p.width * grain) / 2;
    left.push([p.x - Math.sin(angle) * radius, p.y + Math.cos(angle) * radius]);
    right.push([
      p.x + Math.sin(angle) * radius,
      p.y - Math.cos(angle) * radius,
    ]);
  }
  const end = samples[samples.length - 1] || start;
  const second = samples[1] || start,
    beforeEnd = samples[samples.length - 2] || start;
  const startAngle =
    samples.length > 1 ? Math.atan2(second.y - start.y, second.x - start.x) : 0;
  const endAngle =
    samples.length > 1
      ? Math.atan2(end.y - beforeEnd.y, end.x - beforeEnd.x)
      : 0;
  const cap = (/** @type {typeof start} */ p, /** @type {number} */ angle) =>
    Array.from(
      { length: 9 },
      (_, i) =>
        /** @type {XY} */ ([
          p.x + (Math.cos(angle - (Math.PI * i) / 8) * p.width) / 2,
          p.y + (Math.sin(angle - (Math.PI * i) / 8) * p.width) / 2,
        ]),
    );
  const outline = [
    ...left,
    ...cap(end, endAngle + Math.PI / 2),
    ...right.reverse(),
    ...cap(start, startAngle - Math.PI / 2),
  ];
  const contours = [outline];
  if (kind === "graphite") {
    // Deterministic transparent grain remains identical on peers and after save.
    let seed = 17;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const minX = Math.min(...outline.map((p) => p[0])),
      maxX = Math.max(...outline.map((p) => p[0]));
    const minY = Math.min(...outline.map((p) => p[1])),
      maxY = Math.max(...outline.map((p) => p[1]));
    const radius = Math.max(0.25, start.width * 0.045);
    for (let i = 0; i < 300; i++) {
      const x = minX + random() * (maxX - minX),
        y = minY + random() * (maxY - minY);
      /** @type {XY[]} */ const hole = [
        [x - radius, y - radius],
        [x + radius, y - radius],
        [x + radius, y + radius],
        [x - radius, y + radius],
      ];
      if (hole.every((p) => inside(p[0], p[1], outline))) contours.push(hole);
    }
  }
  return polygonFromContours(contours);
}
