import { MutationType } from "../../js/mutation_type.js";
import { TOOL_CODE_BY_ID } from "../manifest.js";
import { PAINT_KINDS, paintFillRule, polygonBounds } from "./geometry.js";

/** @import {ToolBootContext} from "../../../types/app-runtime" */
/** @typedef {{tool:13,type:1,id:string,color:string,size:number,opacity:number,points:string,kind:string,paintRule?:"nonzero"|"evenodd",x:number,y:number,x2:number,y2:number}} PaintCreateMessage */
export const toolId = "paint";
export const drawsOnBoard = true;
export const contract = {
  toolId,
  toolCode: TOOL_CODE_BY_ID.paint,
  storedTagName: "polygon",
  payloadKind: /** @type {const} */ ("inline"),
  /** @param {import("../shape_contract.js").StoredSvgEntry} entry @param {number|undefined} paintOrder @param {import("../shape_contract.js").StoredShapeSummaryHelpers} helpers */
  summarizeStoredSvgItem(entry, paintOrder, helpers) {
    const points = helpers.readStoredSvgAttribute(entry, "points");
    const bounds = polygonBounds(points);
    const kind = helpers.readStoredSvgAttribute(entry, "data-wbo-paint");
    if (!bounds || !PAINT_KINDS.includes(kind || "")) return null;
    return {
      id: helpers.id,
      tool: toolId,
      paintOrder,
      data: helpers.decorateStoredItemData(
        {
          ...bounds,
          points,
          kind,
          paintRule: paintFillRule(
            helpers.readStoredSvgAttribute(entry, "fill-rule"),
          ),
          size:
            helpers.parseNumber(
              helpers.readStoredSvgAttribute(entry, "data-wbo-size"),
            ) || 10,
          color: helpers.readStoredSvgAttribute(entry, "fill") || "#000000",
        },
        helpers.opacity,
        helpers.transform,
      ),
      localBounds: {
        minX: bounds.x,
        minY: bounds.y,
        maxX: bounds.x2,
        maxY: bounds.y2,
      },
    };
  },
  /** @param {import("../shape_contract.js").StoredShapeItem} item @param {import("../shape_contract.js").StoredShapeSerializeHelpers} helpers */
  serializeStoredSvgItem(item, helpers) {
    if (!polygonBounds(item.points) || !PAINT_KINDS.includes(String(item.kind)))
      return "";
    return `<polygon id="${helpers.escapeHtml(item.id || "")}" points="${helpers.escapeHtml(String(item.points))}" data-wbo-paint="${helpers.escapeHtml(String(item.kind))}" data-wbo-size="${helpers.numberOrZero(item.size) || 10}" fill="${helpers.escapeHtml(item.color || "#000000")}" fill-rule="${paintFillRule(item.paintRule)}" stroke="none" opacity="${typeof item.opacity === "number" ? item.opacity : 1}"${helpers.renderTransformAttribute(item.transform)}></polygon>`;
  },
};

/** @param {ToolBootContext} ctx */
export function boot(ctx) {
  return { board: ctx.runtime.board };
}

/** @param {ReturnType<typeof boot>} state @param {any} data */
export function draw(state, data) {
  if (data.type !== MutationType.CREATE || !polygonBounds(data.points)) return;
  const existing = state.board.svg.getElementById(data.id);
  const element = existing || state.board.createSVGElement("polygon");
  for (const [key, value] of Object.entries({
    id: data.id,
    points: data.points,
    "data-wbo-paint": data.kind,
    "data-wbo-size": data.size || 10,
    fill: data.color,
    "fill-rule": paintFillRule(data.paintRule),
    stroke: "none",
    opacity: data.opacity ?? 1,
  }))
    element.setAttribute(key, String(value));
  if (!existing) state.board.drawingArea.appendChild(element);
}
