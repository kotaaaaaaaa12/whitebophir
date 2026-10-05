import MessageCommon from "../../js/message_common.js";

/** @typedef {{key: string, x: number, y: number, x2: number, y2: number, size: number, transform: import("../shape_contract.js").SvgTransform}} Erasure */
export const MAX_ERASURES = 4096;
const ATTRIBUTE = "data-wbo-erasures";
const NS = "http://www.w3.org/2000/svg";

/** @param {unknown} value @param {number} [maxBoardSize] @returns {Erasure | null} */
export function normalizeErasure(
  value,
  maxBoardSize = MessageCommon.LIMITS.DEFAULT_MAX_BOARD_SIZE,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const part = /** @type {Erasure} */ (value);
  const key = MessageCommon.normalizeId(part.key);
  if (
    !key ||
    ![part.x, part.y, part.x2, part.y2].every(
      (n) =>
        typeof n === "number" &&
        Number.isFinite(n) &&
        n >= 0 &&
        n <= maxBoardSize,
    )
  )
    return null;
  if (
    !Number.isInteger(part.size) ||
    part.size < MessageCommon.LIMITS.MIN_SIZE ||
    part.size > MessageCommon.LIMITS.MAX_SIZE
  )
    return null;
  const transform = MessageCommon.normalizeTransformNumbers(part.transform);
  if (
    !transform ||
    Math.abs(transform.a * transform.d - transform.b * transform.c) < 1e-12
  )
    return null;
  return {
    key,
    x: part.x,
    y: part.y,
    x2: part.x2,
    y2: part.y2,
    size: part.size,
    transform,
  };
}

/** @param {string | null | undefined} raw @returns {Erasure[]} */
export function readErasures(raw) {
  if (!raw) return [];
  const parts = JSON.parse(raw);
  if (!Array.isArray(parts) || parts.length > MAX_ERASURES)
    throw new Error("Invalid stored erasures");
  return parts.map((part) => {
    const normalized = normalizeErasure(part);
    if (!normalized) throw new Error("Invalid stored erasure");
    return normalized;
  });
}

/** @param {Erasure[]} parts @param {number} x @param {number} y */
export function isErasedPoint(parts, x, y) {
  return parts.some((part) => {
    // The stored matrix maps the erasing gesture into the object's local space.
    // Invert it here so scaled, rotated and copied objects keep the same holes.
    const m = part.transform;
    const determinant = m.a * m.d - m.b * m.c;
    const dx = x - m.e;
    const dy = y - m.f;
    const px = (m.d * dx - m.c * dy) / determinant;
    const py = (m.a * dy - m.b * dx) / determinant;
    const endX =
      part.x === part.x2 && part.y === part.y2 ? part.x2 + 0.001 : part.x2;
    const vx = endX - part.x;
    const vy = part.y2 - part.y;
    const lengthSquared = vx * vx + vy * vy;
    const t = Math.max(
      0,
      Math.min(1, ((px - part.x) * vx + (py - part.y) * vy) / lengthSquared),
    );
    const distanceX = px - (part.x + t * vx);
    const distanceY = py - (part.y + t * vy);
    return (
      distanceX * distanceX + distanceY * distanceY <= (part.size / 2) ** 2
    );
  });
}

/** @param {string} id */
export function maskId(id) {
  return `wbo-mask-${Array.from(id, (c) => c.codePointAt(0)?.toString(16)).join("-")}`;
}

/** @param {string} tag @param {any} item @param {(s: string) => string} encode */
export function decorateErasedTag(tag, item, encode) {
  if (!tag || !item.erasures?.length) return tag;
  return tag.replace(
    ">",
    ` ${ATTRIBUTE}="${encode(JSON.stringify(item.erasures))}" mask="url(#${maskId(item.id)})">`,
  );
}

/** @param {Erasure} part */
function renderPart(part) {
  const m = part.transform;
  // A tiny segment ensures taps produce a round hole in every SVG renderer.
  const x2 =
    part.x === part.x2 && part.y === part.y2 ? part.x2 + 0.001 : part.x2;
  return `<path d="M ${part.x} ${part.y} L ${x2} ${part.y2}" fill="none" stroke="black" stroke-width="${part.size}" stroke-linecap="round" transform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})"></path>`;
}

/** @param {string} id @param {Erasure[]} parts @param {import("../shape_contract.js").LocalBounds | null} bounds @param {number} size @param {(s: string) => string} encode */
export function renderMask(id, parts, bounds, size, encode) {
  if (!parts?.length || !bounds) return "";
  const pad = size + 2;
  const x = bounds.minX - pad,
    y = bounds.minY - pad;
  const width = bounds.maxX - bounds.minX + pad * 2;
  const height = bounds.maxY - bounds.minY + pad * 2;
  return `<mask id="${encode(maskId(id))}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}" style="mask-type:luminance"><rect x="${x}" y="${y}" width="${width}" height="${height}" style="fill:white;stroke:none"></rect>${parts.map(renderPart).join("")}</mask>`;
}

/** @param {string} prefix @param {string} masks */
export function replaceMaskDefs(prefix, masks) {
  const block = `<defs data-wbo-eraser-defs="true">${masks}</defs>`;
  const clean = prefix.replace(
    /<defs data-wbo-eraser-defs="true">[\s\S]*?<\/defs>/g,
    "",
  );
  return masks
    ? clean.replace('<g id="drawingArea">', `${block}<g id="drawingArea">`)
    : clean;
}

/** @param {SVGSVGElement} svg @param {SVGGraphicsElement} element */
export function refreshMask(svg, element) {
  const parts = readErasures(element.getAttribute(ATTRIBUTE));
  const id = maskId(element.id);
  svg.getElementById(id)?.remove();
  if (!parts.length) {
    element.removeAttribute("mask");
    return;
  }
  const box = element.getBBox();
  const html = renderMask(
    element.id,
    parts,
    {
      minX: box.x,
      minY: box.y,
      maxX: box.x + box.width,
      maxY: box.y + box.height,
    },
    Number(element.getAttribute("stroke-width")) || 1,
    (s) => s,
  );
  let defs = svg.querySelector('defs[data-wbo-eraser-defs="true"]');
  if (!defs) {
    defs = document.createElementNS(NS, "defs");
    defs.setAttribute("data-wbo-eraser-defs", "true");
    svg.insertBefore(defs, svg.firstChild);
  }
  defs.insertAdjacentHTML("beforeend", html);
  element.setAttribute("mask", `url(#${id})`);
}

/** @param {SVGSVGElement} svg @param {SVGGraphicsElement} element @param {Erasure} part */
export function eraseElement(svg, element, part) {
  const parts = readErasures(element.getAttribute(ATTRIBUTE));
  if (
    parts.some((existing) => existing.key === part.key) ||
    parts.length >= MAX_ERASURES
  )
    return;
  parts.push(part);
  element.setAttribute(ATTRIBUTE, JSON.stringify(parts));
  const mask = svg.getElementById(maskId(element.id));
  if (mask) mask.insertAdjacentHTML("beforeend", renderPart(part));
  else refreshMask(svg, element);
}
