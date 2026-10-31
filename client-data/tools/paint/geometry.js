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

/** Stitch closed contours with doubled bridges without changing their winding.
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

// Keep segment contours within the existing polygon and socket limits.
export const MAX_STROKE_SAMPLES = 600;

/** @param {unknown} rule @returns {"nonzero" | "evenodd"} */
export function paintFillRule(rule) {
  return rule === "nonzero" ? "nonzero" : "evenodd";
}

/** Positive-winding convex hull of endpoint disks. Direction never flips
 * the segment's winding, including exact retraces and pressure changes.
 * @param {XY[]} points @returns {XY[]}
 */
function convexHull(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @param {XY} a @param {XY} b @param {XY} c */
  const cross = (a, b, c) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  /** @type {XY[]} */ const lower = [];
  /** @type {XY[]} */ const upper = [];
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(
        /** @type {XY} */ (lower[lower.length - 2]),
        /** @type {XY} */ (lower[lower.length - 1]),
        point,
      ) <= 0
    )
      lower.pop();
    lower.push(point);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = /** @type {XY} */ (sorted[i]);
    while (
      upper.length >= 2 &&
      cross(
        /** @type {XY} */ (upper[upper.length - 2]),
        /** @type {XY} */ (upper[upper.length - 1]),
        point,
      ) <= 0
    )
      upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** @param {XY[]} contour */
function contourBounds(contour) {
  return {
    minX: Math.min(...contour.map((p) => p[0])),
    minY: Math.min(...contour.map((p) => p[1])),
    maxX: Math.max(...contour.map((p) => p[0])),
    maxY: Math.max(...contour.map((p) => p[1])),
  };
}

/** Union consistently wound segment silhouettes with one nonzero fill.
 * Opposite winding is reserved for deterministic graphite grain only.
 * @param {Sample[]} samples @param {string} kind @returns {string}
 */
export function strokePolygon(samples, kind) {
  const start = samples[0];
  if (!start) return "";
  const xDigits = String(
    Math.floor(Math.max(...samples.map((p) => Math.max(0, p.x + p.width)))),
  ).length;
  const yDigits = String(
    Math.floor(Math.max(...samples.map((p) => Math.max(0, p.y + p.width)))),
  ).length;
  // Reserve space for two decimal places, punctuation and contour bridges.
  const vertexBudget = Math.min(
    MAX_POLYGON_POINTS,
    Math.floor(MAX_POLYGON_LENGTH / (xDigits + yDigits + 8)) - 1,
  );
  const disks = samples.map((p, i) => {
    const grain = kind === "graphite" ? 0.82 + ((i * 37) % 19) / 50 : 1;
    const radius = (p.width * grain) / 2;
    return Array.from(
      { length: 12 },
      (_, j) =>
        /** @type {XY} */ ([
          p.x + Math.cos((j * Math.PI) / 6) * radius,
          p.y + Math.sin((j * Math.PI) / 6) * radius,
        ]),
    );
  });
  /** @type {XY[][]} */ const contours = [];
  if (disks.length === 1) contours.push(/** @type {XY[]} */ (disks[0]));
  else
    for (let i = 1; i < disks.length; i++) {
      contours.push(convexHull([...(disks[i - 1] || []), ...(disks[i] || [])]));
    }
  let vertices = 1 + contours.reduce((n, c) => n + c.length + 2, 0);
  if (vertices > vertexBudget) {
    return strokePolygon(
      samples.filter((_, i) => i % 2 === 0 || i === samples.length - 1),
      kind,
    );
  }
  if (kind === "graphite") {
    const segments = contours.map((contour) => ({
      contour,
      ...contourBounds(contour),
    }));
    const minX = Math.min(...segments.map((s) => s.minX)),
      maxX = Math.max(...segments.map((s) => s.maxX));
    const minY = Math.min(...segments.map((s) => s.minY)),
      maxY = Math.max(...segments.map((s) => s.maxY));
    const radius = Math.max(0.25, start.width * 0.045);
    /** @type {XY[]} */ const grains = [];
    let seed = 17;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 300; i++) {
      const x = minX + random() * (maxX - minX),
        y = minY + random() * (maxY - minY);
      if (
        grains.some(
          (p) =>
            Math.abs(x - p[0]) < radius * 2.05 &&
            Math.abs(y - p[1]) < radius * 2.05,
        )
      )
        continue;
      const pad = radius + 0.03;
      /** @type {XY[]} */ const probes = [
        [x - pad, y - pad],
        [x - pad, y + pad],
        [x + pad, y + pad],
        [x + pad, y - pad],
      ];
      let coverage = 0,
        valid = true;
      for (const segment of segments) {
        if (
          segment.maxX < x - pad ||
          segment.minX > x + pad ||
          segment.maxY < y - pad ||
          segment.minY > y + pad
        )
          continue;
        // Only cut grain where coverage is constant across the entire hole.
        if (!probes.every((p) => inside(p[0], p[1], segment.contour))) {
          valid = false;
          break;
        }
        coverage++;
      }
      if (!valid || !coverage || vertices + coverage * 6 > vertexBudget)
        continue;
      // Cancel every covering segment, so grain stays transparent at crossings.
      /** @type {XY[]} */ const hole = [
        [x - radius, y - radius],
        [x - radius, y + radius],
        [x + radius, y + radius],
        [x + radius, y - radius],
      ];
      for (let j = 0; j < coverage; j++) contours.push(hole);
      vertices += coverage * 6;
      grains.push([x, y]);
    }
  }
  return polygonFromContours(contours);
}
