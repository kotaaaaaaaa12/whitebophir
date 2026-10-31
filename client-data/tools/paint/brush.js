import {
  MAX_STROKE_SAMPLES,
  polygonBounds,
  strokePolygon,
} from "./geometry.js";
import { TOOL_CODE_BY_ID } from "../manifest.js";
import { MutationType } from "../../js/mutation_type.js";

/** @import {ToolRuntimeModules} from "../../../types/app-runtime" */
/** @param {ToolRuntimeModules} runtime @param {string} kind */
export function createStroke(runtime, kind) {
  const element = runtime.board.createSVGElement("polygon");
  const color = runtime.preferences.getColor(),
    size = runtime.preferences.getSize();
  const opacity = Math.max(
    0.1,
    runtime.preferences.getOpacity() *
      (kind === "marker" ? 0.4 : kind === "graphite" ? 0.8 : 1),
  );
  element.setAttribute("fill", color);
  element.setAttribute("fill-rule", "nonzero");
  element.setAttribute("stroke", "none");
  element.setAttribute("opacity", String(opacity));
  element.style.pointerEvents = "none";
  runtime.board.svg.appendChild(element);
  const lease = runtime.interaction.suppressOwnCursor();
  return {
    runtime,
    kind,
    element,
    color,
    size,
    opacity,
    lease,
    samples: /** @type {{x:number,y:number,width:number}[]} */ ([]),
    lastTime: performance.now(),
    frame: 0,
    finished: false,
  };
}
/** @typedef {ReturnType<typeof createStroke>} Stroke */
/** @param {Stroke} stroke @param {number} x @param {number} y @param {MouseEvent|TouchEvent|undefined} evt */
export function move(stroke, x, y, evt) {
  if (stroke.finished) return;
  evt?.preventDefault();
  const prev = stroke.samples[stroke.samples.length - 1],
    now = performance.now();
  const distance = prev ? Math.hypot(x - prev.x, y - prev.y) : 0;
  if (prev && distance < Math.max(0.5, stroke.size / 30)) return;
  let factor = 1;
  if (stroke.kind === "brush") {
    const touch = evt && "touches" in evt ? evt.touches[0] : null;
    const force = touch?.force;
    factor =
      force && force > 0
        ? 0.25 + Math.min(1, force) * 0.75
        : Math.max(
            0.22,
            1 - distance / Math.max(1, now - stroke.lastTime) / 12,
          );
    factor = prev ? (0.65 * prev.width) / stroke.size + 0.35 * factor : 0.3;
  }
  stroke.lastTime = now;
  stroke.samples.push({ x, y, width: stroke.size * factor });
  if (stroke.samples.length > MAX_STROKE_SAMPLES) {
    // Retain the latest endpoint while bounding memory and SVG complexity.
    stroke.samples = stroke.samples.filter(
      (_, i) => i % 2 === 0 || i === stroke.samples.length - 1,
    );
  }
  if (!stroke.frame)
    stroke.frame = requestAnimationFrame(() => {
      stroke.frame = 0;
      if (!stroke.finished)
        stroke.element.setAttribute(
          "points",
          strokePolygon(stroke.samples, stroke.kind),
        );
    });
}
/** @param {Stroke} stroke */
export function cancel(stroke) {
  stroke.finished = true;
  if (stroke.frame) cancelAnimationFrame(stroke.frame);
  stroke.element.remove();
  stroke.lease.release();
}
/** @param {Stroke} stroke @param {number} x @param {number} y */
export function finish(stroke, x, y) {
  move(stroke, x, y, undefined);
  try {
    const points = strokePolygon(stroke.samples, stroke.kind),
      bounds = polygonBounds(points);
    if (!bounds || !stroke.runtime.writes.canBufferWrites()) return;
    stroke.runtime.writes.drawAndSend({
      tool: TOOL_CODE_BY_ID.paint,
      type: MutationType.CREATE,
      id: stroke.runtime.ids.generateUID("v"),
      points,
      kind: stroke.kind,
      paintRule: "nonzero",
      ...bounds,
      color: stroke.color,
      size: stroke.size,
      opacity: stroke.opacity,
    });
  } finally {
    cancel(stroke);
  }
}
