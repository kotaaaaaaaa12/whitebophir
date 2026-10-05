/**
 *                        WHITEBOPHIR
 *********************************************************
 * @licstart  The following is the entire license notice for the
 *  JavaScript code in this page.
 *
 * Copyright (C) 2013  Ophir LOJKINE
 *
 *
 * The JavaScript code in this page is free software: you can
 * redistribute it and/or modify it under the terms of the GNU
 * General Public License (GNU GPL) as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option)
 * any later version.  The code is distributed WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU GPL for more details.
 *
 * As additional permission under GNU GPL version 3 section 7, you
 * may distribute non-source (e.g., minimized or compacted) forms of
 * that code without the copy of the GNU GPL normally required by
 * section 4, provided you include this license notice and a URL
 * through which recipients can access the Corresponding Source.
 *
 * @licend
 */

import { eraseElement, maskId, normalizeErasure } from "./partial_erase.js";
import { logFrontendEvent } from "../../js/frontend_logging.js";
import {
  getMutationType,
  MutationType,
} from "../../js/message_tool_metadata.js";
import { TOOL_CODE_BY_ID } from "../tool-order.js";

/** @import { ToolBootContext } from "../../../types/app-runtime" */
/** @typedef {ReturnType<typeof createDeleteMessage>} EraserDeleteMessage */
/** @typedef {{tool: typeof toolCode, type: typeof MutationType.UPDATE, id: string, erasure: import("./partial_erase.js").Erasure}} EraserUpdateMessage */
/** @typedef {EraserDeleteMessage | EraserUpdateMessage} EraserMessage */
/** @typedef {{preventDefault(): void, target: EventTarget | null, type?: string, touches?: TouchList}} EraserPointerEvent */
/** @typedef {ReturnType<typeof boot>} EraserState */

export const toolId = "eraser";
const toolCode = TOOL_CODE_BY_ID[toolId];
export const shortcut = "e";
export const showMarker = true;
export const helpText = "eraser_help";
export const updatableFields = ["erasure"];
export const liveMessageFields = /** @type {const} */ ({
  [MutationType.DELETE]: { id: "id" },
  [MutationType.UPDATE]: { id: "id", erasure: "erasure" },
});

/**
 * @param {EventTarget | null} elem
 * @returns {elem is Element}
 */
function isElement(elem) {
  return !!(elem && typeof elem === "object" && "parentNode" in elem);
}

/**
 * @param {EventTarget | null} elem
 * @returns {elem is Element & {id: string}}
 */
function isErasableElement(elem) {
  return !!(isElement(elem) && typeof elem.id === "string" && elem.id !== "");
}

/**
 * @param {EraserState} state
 * @param {EventTarget | null} elem
 * @returns {boolean}
 */
function inDrawingArea(state, elem) {
  return isElement(elem) && state.board.drawingArea.contains(elem);
}

/**
 * @param {EraserPointerEvent} evt
 * @returns {EventTarget | null}
 */
function resolveTarget(evt) {
  let target = evt.target;
  if (evt.type === "touchmove" || evt.type === "touchstart") {
    const touch = evt.touches && evt.touches[0];
    if (touch) {
      target = document.elementFromPoint(touch.clientX, touch.clientY);
    }
  }
  return target;
}

/** @param {string} id */
function createDeleteMessage(id) {
  return {
    tool: toolCode,
    type: MutationType.DELETE,
    id,
  };
}

/**
 * @param {EraserState} state
 * @param {number} x
 * @param {number} y
 * @param {EraserPointerEvent} evt
 */
export function press(state, x, y, evt) {
  void x;
  void y;
  evt.preventDefault();
  state.erasing = true;
  state.lastPoint = { x, y };
  if (state.secondary.active) eraseSegment(state, x, y);
  else move(state, x, y, evt);
}

/**
 * @param {EraserState} state
 * @param {number} x
 * @param {number} y
 * @param {EraserPointerEvent} evt
 */
export function move(state, x, y, evt) {
  void x;
  void y;
  if (state.erasing && state.secondary.active) {
    state.pendingPoint = { x, y };
    if (state.frame === null)
      state.frame = requestAnimationFrame(() => flushPartialErase(state));
    return;
  }
  const target = resolveTarget(/** @type {EraserPointerEvent} */ (evt));
  if (
    state.erasing &&
    target !== null &&
    target !== state.board.svg &&
    target !== state.board.drawingArea &&
    isErasableElement(target) &&
    inDrawingArea(state, target)
  ) {
    state.writes.drawAndSend(createDeleteMessage(target.id));
  }
}

/** @param {EraserState} state @param {number} [x] @param {number} [y] */
export function release(state, x, y) {
  if (
    state.erasing &&
    state.secondary.active &&
    x !== undefined &&
    y !== undefined &&
    (x !== state.lastPoint?.x || y !== state.lastPoint?.y)
  )
    state.pendingPoint = { x, y };
  flushPartialErase(state);
  state.erasing = false;
  state.lastPoint = null;
}

/** @param {EraserState} state */
function flushPartialErase(state) {
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  state.frame = null;
  const point = state.pendingPoint;
  state.pendingPoint = null;
  if (point && state.erasing) eraseSegment(state, point.x, point.y);
}

/** @param {EraserState} state @param {number} x @param {number} y */
function eraseSegment(state, x, y) {
  const previous = state.lastPoint || { x, y };
  const size = state.preferences.getSize();
  const area = state.board.svg.createSVGRect();
  area.x = Math.min(previous.x, x) - size / 2;
  area.y = Math.min(previous.y, y) - size / 2;
  area.width = Math.abs(previous.x - x) + size;
  area.height = Math.abs(previous.y - y) + size;
  const targets = state.board.svg.getIntersectionList(
    area,
    state.board.drawingArea,
  );
  const key = state.ids.generateUID("er");
  for (const target of Array.from(targets)) {
    if (
      !(target instanceof SVGGraphicsElement) ||
      target.parentNode !== state.board.drawingArea ||
      !target.id
    )
      continue;
    const matrix = target.transform.baseVal.consolidate()?.matrix;
    if (matrix && Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12)
      continue;
    const inverse = matrix
      ? matrix.inverse()
      : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const erasure = normalizeErasure({
      key,
      x: previous.x,
      y: previous.y,
      x2: x,
      y2: y,
      size,
      transform: {
        a: inverse.a,
        b: inverse.b,
        c: inverse.c,
        d: inverse.d,
        e: inverse.e,
        f: inverse.f,
      },
    });
    if (erasure)
      state.writes.drawAndSend({
        tool: toolCode,
        type: MutationType.UPDATE,
        id: target.id,
        erasure,
      });
  }
  state.lastPoint = { x, y };
}

/** @param {EraserState} state */
export function onquit(state) {
  release(state);
}
/** @param {EraserState} state */
export function onSocketDisconnect(state) {
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  state.frame = null;
  state.pendingPoint = null;
  state.erasing = false;
  state.lastPoint = null;
}

/**
 * @param {EraserState} state
 * @param {EraserMessage | {type?: unknown, id?: string, erasure?: unknown}} data
 */
export function draw(state, data) {
  if (getMutationType(data) === MutationType.UPDATE && "erasure" in data) {
    const part = normalizeErasure(data.erasure);
    const target = data.id ? state.board.svg.getElementById(data.id) : null;
    if (
      part &&
      target instanceof SVGGraphicsElement &&
      target.parentNode === state.board.drawingArea
    )
      eraseElement(state.board.svg, target, part);
    return;
  }
  if (getMutationType(data) !== MutationType.DELETE) {
    logFrontendEvent("error", "tool.eraser.draw_invalid_type", {
      mutationType: data?.type,
      message: data,
    });
    return;
  }
  if (!data.id) {
    logFrontendEvent("error", "tool.eraser.delete_missing_id", {
      message: data,
    });
    return;
  }
  const elem = state.board.svg.getElementById(data.id);
  if (elem === null) {
    logFrontendEvent("warn", "tool.eraser.delete_missing_target", {
      id: data.id,
    });
  } else {
    state.board.svg.getElementById(maskId(elem.id))?.remove();
    state.board.drawingArea.removeChild(elem);
  }
}

/** @param {ToolBootContext} ctx */
export function boot(ctx) {
  const state = {
    board: ctx.runtime.board,
    writes: ctx.runtime.writes,
    preferences: ctx.runtime.preferences,
    ids: ctx.runtime.ids,
    erasing: false,
    lastPoint: /** @type {{x: number, y: number} | null} */ (null),
    pendingPoint: /** @type {{x: number, y: number} | null} */ (null),
    frame: /** @type {number | null} */ (null),
    secondary: {
      name: "partial_eraser",
      icon: "tools/eraser/partial.svg",
      active: false,
      switch: () => {},
    },
    mouseCursor: `url('${ctx.assetUrl("icon.svg")}') 8 24, crosshair`,
  };
  state.secondary.switch = () => release(state);
  return state;
}

/** @param {EraserState} state */
export function cancelTouchGesture(state) {
  onSocketDisconnect(state);
}

/** @param {EraserState} state */
export function onMutationRejected(state) {
  onSocketDisconnect(state);
}
