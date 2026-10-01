import { showModalDialog } from "./board_ui_module.js";

/** @import { AppToolsState } from "../../types/app-runtime" */

/** @param {string} value */
function normalizeHex(value) {
  return /^#?[0-9a-f]{6}$/i.test(value.trim())
    ? `#${value.trim().replace(/^#/, "").toLowerCase()}`
    : null;
}

/** @param {AppToolsState} Tools */
export async function chooseCustomColor(Tools) {
  const color = await showModalDialog(
    /** @type {string | null} */ (null),
    (panel, settle) => {
      panel.classList.add("custom-color-dialog");
      const title = document.createElement("div");
      title.id = "custom-color-title";
      title.className = "wbo-dialog-title";
      title.textContent = Tools.i18n.t("custom_color");
      panel.closest("dialog")?.setAttribute("aria-labelledby", title.id);
      const form = document.createElement("form");
      const preview = document.createElement("div");
      preview.className = "custom-color-preview";
      preview.setAttribute("aria-hidden", "true");
      const label = document.createElement("label");
      label.textContent = Tools.i18n.t("color_hex");
      const hex = document.createElement("input");
      hex.type = "text";
      hex.id = "customColorHex";
      hex.maxLength = 7;
      hex.pattern = "#?[0-9a-fA-F]{6}";
      hex.required = true;
      hex.spellcheck = false;
      hex.autocomplete = "off";
      label.appendChild(hex);
      form.append(preview, label);
      /** @type {HTMLInputElement[]} */
      const sliders = [];
      /** @type {HTMLOutputElement[]} */
      const outputs = [];
      for (const channel of ["red", "green", "blue"]) {
        const row = document.createElement("label");
        row.className = "custom-color-channel";
        const name = document.createElement("span");
        name.textContent = Tools.i18n.t(`color_${channel}`);
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "255";
        slider.step = "1";
        slider.id = `customColor${channel}`;
        const output = document.createElement("output");
        output.htmlFor = slider.id;
        row.append(name, slider, output);
        sliders.push(slider);
        outputs.push(output);
        slider.addEventListener("input", () =>
          syncColor(
            `#${sliders.map((item) => Number(item.value).toString(16).padStart(2, "0")).join("")}`,
          ),
        );
        form.appendChild(row);
      }
      /** @param {string} value */
      function syncColor(value) {
        hex.value = value;
        preview.style.backgroundColor = value;
        sliders.forEach((slider, index) => {
          slider.value = String(
            Number.parseInt(value.slice(1 + index * 2, 3 + index * 2), 16),
          );
          const output = outputs[index];
          if (output) output.value = slider.value;
        });
      }
      hex.addEventListener("input", () => {
        const valid = normalizeHex(hex.value);
        if (valid) syncColor(valid);
      });
      syncColor(normalizeHex(Tools.preferences.currentColor) || "#000000");
      const actions = document.createElement("div");
      actions.className = "wbo-dialog-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.autofocus = true;
      cancel.className = "wbo-dialog-button wbo-dialog-button-secondary";
      cancel.textContent = Tools.i18n.t("cancel");
      cancel.addEventListener("click", () => settle(null));
      const apply = document.createElement("button");
      apply.type = "submit";
      apply.className = "wbo-dialog-button wbo-dialog-button-primary";
      apply.textContent = Tools.i18n.t("color_apply");
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const valid = normalizeHex(hex.value);
        if (valid) settle(valid);
      });
      actions.append(cancel, apply);
      form.appendChild(actions);
      panel.append(title, form);
    },
  );
  if (color !== null) Tools.preferences.setColor(color);
}
