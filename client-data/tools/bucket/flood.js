import { polygonFromContours } from "../paint/geometry.js";

/** Flood the visible composited color. Reaching any crop edge fails closed.
 * @param {Uint8ClampedArray} rgba @param {number} width @param {number} height
 * @param {number} seedX @param {number} seedY @param {number} originX @param {number} originY @param {number} [step]
 */
export function floodPolygon(
  rgba,
  width,
  height,
  seedX,
  seedY,
  originX = 0,
  originY = 0,
  step = 1,
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 3 ||
    height < 3 ||
    width * height > 2048 * 2048 ||
    rgba.length !== width * height * 4 ||
    seedX < 0 ||
    seedY < 0 ||
    seedX >= width ||
    seedY >= height
  )
    throw new Error("bucket_open");
  const seed = (Math.floor(seedY) * width + Math.floor(seedX)) * 4;
  // Composite transparent pixels on the white board before comparing colors.
  const component = (/** @type {number} */ p, /** @type {number} */ c) =>
    255 + (((rgba[p + c] ?? 255) - 255) * (rgba[p + 3] ?? 0)) / 255;
  /** @type {[number,number,number]} */ const target = [
    component(seed, 0),
    component(seed, 1),
    component(seed, 2),
  ];
  const match = (/** @type {number} */ i) => {
    const p = i * 4;
    return (
      Math.abs(component(p, 0) - target[0]) <= 18 &&
      Math.abs(component(p, 1) - target[1]) <= 18 &&
      Math.abs(component(p, 2) - target[2]) <= 18
    );
  };
  const seen = new Uint8Array(width * height),
    queue = new Uint32Array(width * height);
  let read = 0,
    write = 1;
  queue[0] = Math.floor(seedY) * width + Math.floor(seedX);
  seen[queue[0]] = 1;
  while (read < write) {
    const index = queue[read++] ?? 0,
      x = index % width,
      y = Math.floor(index / width);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1)
      throw new Error("bucket_open");
    for (const next of [index - 1, index + 1, index - width, index + width]) {
      if (!seen[next] && match(next)) {
        seen[next] = 1;
        queue[write++] = next;
      }
    }
  }
  if (write < 2) throw new Error("bucket_empty");
  /** @type {import("../paint/geometry.js").XY[][]} */ const contours = [];
  /** @type {Map<string,import("../paint/geometry.js").XY[]>} */ let previous =
    new Map();
  for (let y = 1; y < height - 1; y++) {
    /** @type {Map<string,import("../paint/geometry.js").XY[]>} */ const current =
      new Map();
    for (let x = 1; x < width - 1; x++) {
      if (!seen[y * width + x]) continue;
      const start = x;
      while (x + 1 < width && seen[y * width + x + 1]) x++;
      const end = x + 1,
        key = `${start}:${end}`;
      const rectangle = previous.get(key);
      if (rectangle) {
        const bottomRight = rectangle[2],
          bottomLeft = rectangle[3];
        if (bottomRight && bottomLeft)
          bottomRight[1] = bottomLeft[1] = originY + (y + 1) * step;
        current.set(key, rectangle);
      } else {
        /** @type {import("../paint/geometry.js").XY[]} */ const next = [
          [originX + start * step, originY + y * step],
          [originX + end * step, originY + y * step],
          [originX + end * step, originY + (y + 1) * step],
          [originX + start * step, originY + (y + 1) * step],
        ];
        contours.push(next);
        current.set(key, next);
        if (contours.length > 1700) throw new Error("paint_too_complex");
      }
    }
    previous = current;
  }
  return polygonFromContours(contours);
}
