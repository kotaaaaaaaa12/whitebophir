import { MutationType } from "../../js/mutation_type.js";
import { TOOL_CODE_BY_ID } from "../manifest.js";
import { polygonBounds } from "../paint/geometry.js";
import { floodPolygon } from "./flood.js";
import { logFrontendEvent, errorLogFields } from "../../js/frontend_logging.js";

/** @import {ToolBootContext} from "../../../types/app-runtime" */
export const toolId = "bucket";
export const drawsOnBoard = true;
export const shortcut = "b";
export const mouseCursor = "crosshair";
export const helpText = "bucket_help";
/** @param {ToolBootContext} ctx */
export function boot(ctx) {
  return {
    runtime: ctx.runtime,
    generation: 0,
    busy: false,
    paintReady: ctx.runtime.toolRegistry.bootTool("paint"),
  };
}
/** @param {ReturnType<typeof boot>} _state @param {unknown} _data */
export function draw(_state, _data) {}

/** @param {ReturnType<typeof boot>} state @param {string} key */
async function showError(state, key) {
  const { showModalDialog } = await import("../../js/board_ui_module.js");
  await showModalDialog(null, (panel, close) => {
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-label", state.runtime.i18n.t("bucket"));
    const message = document.createElement("p");
    message.className = "wbo-dialog-message";
    message.textContent = state.runtime.i18n.t(key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wbo-dialog-button";
    button.textContent = state.runtime.i18n.t("paint_close");
    button.addEventListener("click", () => close(null));
    panel.append(message, button);
    // Do not leave a touch focus ring on the dialog or its close button.
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
  });
}

/** @param {ReturnType<typeof boot>} state @param {number} x @param {number} y */
async function fill(state, x, y) {
  if (state.busy || !state.runtime.writes.canBufferWrites()) return;
  const generation = ++state.generation;
  state.busy = true;
  const { runtime } = state;
  const color = runtime.preferences.getColor(),
    opacity = runtime.preferences.getOpacity();
  const max = runtime.config.serverConfig.MAX_BOARD_SIZE || 655360;
  // Bound memory while matching the visible board resolution when zoomed out.
  const pixelScale = Math.max(0.125, Math.min(1, runtime.viewport.getScale()));
  const step = 1 / pixelScale;
  const originX = Math.max(0, Math.floor(x - 1024 * step)),
    originY = Math.max(0, Math.floor(y - 1024 * step));
  const width = Math.min(2048, Math.floor((max - originX) / step)),
    height = Math.min(2048, Math.floor((max - originY) / step));
  document.getElementById("toolID-bucket")?.setAttribute("aria-busy", "true");
  let url = "";
  try {
    if (!(await state.paintReady)) throw new Error("bucket_failed");
    if (generation !== state.generation) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute(
      "viewBox",
      `${originX} ${originY} ${width * step} ${height * step}`,
    );
    for (const defs of runtime.board.svg.querySelectorAll(":scope > defs"))
      svg.appendChild(defs.cloneNode(true));
    const drawing = runtime.board.drawingArea.cloneNode(true);
    if (drawing instanceof Element) drawing.removeAttribute("style");
    if (drawing instanceof Element) {
      for (const shape of drawing.querySelectorAll("path,rect,ellipse,line")) {
        if (!shape.hasAttribute("fill")) shape.setAttribute("fill", "none");
        if (shape.tagName === "path") {
          shape.setAttribute("stroke-linecap", "round");
          shape.setAttribute("stroke-linejoin", "round");
        }
      }
    }
    svg.appendChild(drawing);
    const markup = new XMLSerializer().serializeToString(svg);
    if (markup.length > 8_000_000) throw new Error("paint_too_complex");
    url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    const image = new Image();
    image.src = url;
    await image.decode();
    if (generation !== state.generation) return;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("bucket_failed");
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    // Yield before bounded CPU work so the first tap can paint its UI feedback.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (generation !== state.generation) return;
    const points = floodPolygon(
      pixels,
      width,
      height,
      Math.floor((x - originX) / step),
      Math.floor((y - originY) / step),
      originX,
      originY,
      step,
    );
    const bounds = polygonBounds(points, max);
    if (
      !bounds ||
      generation !== state.generation ||
      !runtime.permissions.canEdit ||
      !runtime.writes.canBufferWrites()
    )
      return;
    runtime.writes.drawAndSend({
      tool: TOOL_CODE_BY_ID.paint,
      type: MutationType.CREATE,
      id: runtime.ids.generateUID("f"),
      kind: "bucket",
      points,
      ...bounds,
      color,
      opacity,
      size: 10,
    });
  } catch (error) {
    if (generation === state.generation) {
      logFrontendEvent("warn", "tool.bucket.failed", errorLogFields(error));
      const key =
        error instanceof Error &&
        ["bucket_open", "bucket_empty", "paint_too_complex"].includes(
          error.message,
        )
          ? error.message
          : "bucket_failed";
      void showError(state, key);
    }
  } finally {
    if (url) URL.revokeObjectURL(url);
    state.busy = false;
    document
      .getElementById("toolID-bucket")
      ?.setAttribute("aria-busy", "false");
  }
}

/** @param {ReturnType<typeof boot>} state @param {number} x @param {number} y @param {MouseEvent|TouchEvent} event */
export function press(state, x, y, event) {
  event.preventDefault();
  void fill(state, x, y);
}
/** @param {ReturnType<typeof boot>} state */
export function cancelTouchGesture(state) {
  state.generation++;
}
export const onquit = cancelTouchGesture;
export const onSocketDisconnect = cancelTouchGesture;
/** @param {ReturnType<typeof boot>} state @param {{tool?:number}} message */
export function onMessage(state, message) {
  if (message.tool !== TOOL_CODE_BY_ID.cursor) state.generation++;
}
