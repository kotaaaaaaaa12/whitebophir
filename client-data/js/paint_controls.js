import { getBrushSelection, selectBrush } from "./brush_selection.js";

const PALETTE_KEY = "wbo.customPalette";
const HEX = /^#[0-9a-f]{6}$/i;
/** @param {unknown} value @returns {string[]} */
export function normalizePalette(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((c) => typeof c === "string" && HEX.test(c))
        .map((c) => c.toLowerCase()),
    ),
  ].slice(0, 64);
}
export function readPalette() {
  try {
    return normalizePalette(
      JSON.parse(localStorage.getItem(PALETTE_KEY) || "[]"),
    );
  } catch {
    return [];
  }
}

/** @param {import("../../types/app-runtime").AppToolsState} Tools */
export function installPaintControls(Tools) {
  const stylePanel = document.getElementById("stylePanel"),
    colors = document.getElementById("colorPresetSel"),
    pen = document.getElementById("toolID-pencil");
  if (!stylePanel || !colors || !pen || document.getElementById("brushPalette"))
    return;
  const t = (/** @type {string} */ key) => Tools.i18n.t(key);
  const button = (
    /** @type {string} */ key,
    /** @type {string} */ text,
    /** @type {()=>void} */ action,
  ) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = t(key);
    b.setAttribute("aria-label", t(key));
    b.textContent = text;
    b.addEventListener("click", () => {
      action();
      b.blur();
    });
    return b;
  };
  let palette = readPalette();
  const status = document.createElement("p");
  status.className = "paint-control-status";
  status.setAttribute("role", "status");
  const editor = document.createElement("div");
  editor.className = "palette-editor";
  editor.hidden = true;
  const input = document.createElement("input");
  input.type = "text";
  input.id = "paletteHex";
  input.maxLength = 7;
  input.placeholder = "#12ab34";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", t("palette_hex"));
  const rows = document.createElement("div");
  rows.className = "palette-editor-rows";
  const save = () => {
    try {
      localStorage.setItem(PALETTE_KEY, JSON.stringify(palette));
      status.textContent = "";
    } catch {
      status.textContent = t("palette_failed");
    }
    render();
  };
  /** @param {string} color */
  const add = (color) => {
    if (!HEX.test(color)) {
      status.textContent = t("palette_invalid");
      return;
    }
    color = color.toLowerCase();
    if (!palette.includes(color)) {
      if (palette.length >= 64) {
        status.textContent = t("palette_full");
        return;
      }
      palette.push(color);
      save();
    }
    Tools.preferences.setColor(color);
  };
  const addHex = button("palette_add", "+", () => add(input.value));
  const form = document.createElement("div");
  form.className = "palette-hex-row";
  form.append(input, addHex);
  editor.append(form, rows);
  const actions = document.createElement("div");
  actions.className = "palette-actions";
  const addCurrent = button("palette_add", "+", () =>
    add(Tools.preferences.getColor()),
  );
  addCurrent.id = "paletteAdd";
  const edit = button("palette_edit", t("palette_edit"), () => {
    editor.hidden = !editor.hidden;
    edit.setAttribute("aria-expanded", String(!editor.hidden));
    input.value = Tools.preferences.getColor();
  });
  edit.id = "paletteEdit";
  edit.setAttribute("aria-expanded", "false");
  actions.append(addCurrent, edit);
  colors.after(actions, editor, status);
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      add(input.value);
    }
  });
  input.addEventListener("keyup", (event) => event.stopPropagation());
  function render() {
    colors?.querySelectorAll("[data-custom-color]").forEach((e) => e.remove());
    rows.replaceChildren();
    palette.forEach((color, index) => {
      const swatch = button("color", "", () =>
        Tools.preferences.setColor(color),
      );
      swatch.className = "colorPresetButton";
      swatch.style.backgroundColor = color;
      swatch.dataset.color = color;
      swatch.dataset.customColor = color;
      swatch.title = `${t("color")} ${color}`;
      swatch.setAttribute("aria-label", swatch.title);
      colors?.insertBefore(
        swatch,
        document.getElementById("colorPresetCustom"),
      );
      const row = document.createElement("div");
      row.className = "palette-editor-row";
      const label = document.createElement("span");
      label.textContent = color;
      label.style.borderInlineStart = `12px solid ${color}`;
      const earlier = button("palette_earlier", "↑", () => {
        if (index > 0) {
          palette.splice(
            index - 1,
            2,
            palette[index] || color,
            palette[index - 1] || color,
          );
          save();
        }
      });
      const later = button("palette_later", "↓", () => {
        if (index + 1 < palette.length) {
          palette.splice(
            index,
            2,
            palette[index + 1] || color,
            palette[index] || color,
          );
          save();
        }
      });
      earlier.disabled = index === 0;
      later.disabled = index === palette.length - 1;
      const remove = button("palette_remove", "×", () => {
        palette.splice(index, 1);
        save();
      });
      row.append(label, earlier, later, remove);
      rows.appendChild(row);
    });
    syncColor();
  }
  function syncColor() {
    for (const swatch of colors?.querySelectorAll("[data-custom-color]") ||
      []) {
      const element = /** @type {HTMLElement} */ (swatch);
      element.setAttribute(
        "aria-pressed",
        String(
          element.dataset.color === Tools.preferences.getColor().toLowerCase(),
        ),
      );
    }
  }
  Tools.preferences.colorChangeHandlers.push(syncColor);
  window.addEventListener("storage", (event) => {
    if (event.key === PALETTE_KEY) {
      palette = readPalette();
      render();
    }
  });
  render();

  const panel = document.createElement("section");
  panel.id = "brushPalette";
  panel.className = "brush-palette";
  panel.hidden = true;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", t("pen_palette"));
  const heading = document.createElement("div");
  heading.className = "brush-palette-heading";
  heading.textContent = t("pen_palette");
  const choices = document.createElement("div");
  choices.className = "brush-choices";
  panel.append(heading, choices);
  document.body.appendChild(panel);
  const keys = ["pen", "graphite", "marker", "brush"];
  let selecting = false;
  /** @param {string} kind */
  const choose = async (kind) => {
    if (selecting) return;
    selecting = true;
    try {
      await Tools.toolRegistry.bootTool("paint");
      await selectBrush(kind);
      await Tools.toolRegistry.activateTool("pencil");
      for (const b of choices.querySelectorAll("button"))
        b.setAttribute("aria-pressed", String(b.dataset.brush === kind));
      const icon = pen?.querySelector(".tool-icon");
      if (icon instanceof HTMLImageElement)
        icon.src = Tools.assets.resolveAssetPath(
          kind === "pen" ? "tools/pencil/icon.svg" : `tools/paint/${kind}.svg`,
        );
      panel.hidden = true;
      pen?.setAttribute("aria-expanded", "false");
    } catch {
      status.textContent = t("bucket_failed");
    } finally {
      selecting = false;
    }
  };
  for (const kind of keys) {
    const b = button(`brush_${kind}`, "", () => {
      void choose(kind);
    });
    b.dataset.brush = kind;
    b.setAttribute("aria-pressed", String(getBrushSelection().kind === kind));
    const img = document.createElement("img");
    img.alt = "";
    img.width = 36;
    img.height = 36;
    img.src = Tools.assets.resolveAssetPath(
      kind === "pen" ? "tools/pencil/icon.svg" : `tools/paint/${kind}.svg`,
    );
    const name = document.createElement("span");
    name.textContent = t(`brush_${kind}`);
    b.append(img, name);
    choices.appendChild(b);
  }
  const position = () => {
    if (!panel.hidden && pen)
      Tools.ui.positionAnchoredPanel({
        anchor: pen,
        panel,
        gap: 8,
        margin: 8,
        fallbackWidth: 240,
      });
  };
  pen.setAttribute("aria-controls", "brushPalette");
  pen.setAttribute("aria-expanded", "false");
  pen.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    pen.setAttribute("aria-expanded", String(!panel.hidden));
    position();
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      event.target instanceof Node &&
      !panel.contains(event.target) &&
      !pen.contains(event.target)
    ) {
      panel.hidden = true;
      pen.setAttribute("aria-expanded", "false");
    }
  });
  panel.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      panel.hidden = true;
      pen.setAttribute("aria-expanded", "false");
    }
  });
  for (const type of [
    "pointerdown",
    "pointerup",
    "touchstart",
    "touchmove",
    "touchend",
    "wheel",
    "keyup",
  ])
    panel.addEventListener(type, (event) => event.stopPropagation());
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  const penKey = (/** @type {KeyboardEvent} */ event) => {
    if (
      event.key === "p" &&
      !(
        event.target instanceof Element &&
        event.target.closest("input,textarea,select,[contenteditable=true]")
      )
    ) {
      panel.hidden = false;
      pen.setAttribute("aria-expanded", "true");
      position();
    }
  };
  window.addEventListener("keydown", penKey);
  try {
    const stored = localStorage.getItem("wbo.brush");
    if (stored && keys.includes(stored) && stored !== "pen") {
      restoreBrush(stored);
    }
  } catch {
    /* Storage is optional. */
  }
  /** @param {string} kind */
  function restoreBrush(kind) {
    // Restore the brush without changing the initially selected navigation tool.
    void Tools.toolRegistry
      .bootTool("paint")
      .then(() => selectBrush(kind))
      .then(() => {
        for (const b of choices.querySelectorAll("button"))
          b.setAttribute("aria-pressed", String(b.dataset.brush === kind));
        const icon = pen?.querySelector(".tool-icon");
        if (icon instanceof HTMLImageElement)
          icon.src = Tools.assets.resolveAssetPath(`tools/paint/${kind}.svg`);
      })
      .catch(() => {});
  }
  pen.dataset.brushPickerReady = "true";
}
