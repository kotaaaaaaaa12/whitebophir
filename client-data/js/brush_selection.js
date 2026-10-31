let selected = "pen";
/** @type {typeof import("../tools/paint/brush.js") | null} */
let engine = null;
export function getBrushSelection() {
  return { kind: selected, engine };
}
/** @param {string} kind */
export async function selectBrush(kind) {
  if (!["pen", "graphite", "marker", "brush"].includes(kind)) return;
  if (kind !== "pen") engine = await import("../tools/paint/brush.js");
  selected = kind;
  try {
    localStorage.setItem("wbo.brush", kind);
  } catch {
    /* Storage is optional. */
  }
}
