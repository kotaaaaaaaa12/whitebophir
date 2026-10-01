import { showConfirmDialog, showModalDialog } from "./board_ui_module.js";

/** @import { AppToolsState } from "../../types/app-runtime" */

/** @param {AppToolsState} Tools @param {URL} url */
function signIn(Tools, url) {
  return showModalDialog(false, (panel, settle) => {
    panel.classList.add("admin-session-dialog");
    const title = document.createElement("div");
    title.id = "admin-login-title";
    title.className = "wbo-dialog-title";
    title.textContent = Tools.i18n.t("admin_sign_in");
    panel.closest("dialog")?.setAttribute("aria-labelledby", title.id);
    const form = document.createElement("form");
    const label = document.createElement("label");
    label.textContent = Tools.i18n.t("board_admin_key");
    const password = document.createElement("input");
    password.type = "password";
    password.autocomplete = "current-password";
    password.maxLength = 256;
    password.required = true;
    label.appendChild(password);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "wbo-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.autofocus = true;
    cancel.className = "wbo-dialog-button wbo-dialog-button-secondary";
    cancel.textContent = Tools.i18n.t("cancel");
    cancel.addEventListener("click", () => settle(false));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "wbo-dialog-button wbo-dialog-button-primary";
    submit.textContent = Tools.i18n.t("admin_sign_in");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      cancel.disabled = true;
      status.textContent = "";
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-wbo-admin": "1" },
          body: JSON.stringify({ password: password.value }),
        });
        password.value = "";
        if (response.ok) settle(true);
        else
          status.textContent = Tools.i18n.t(
            response.status === 429
              ? "admin_login_rate_limited"
              : "admin_login_failed",
          );
      } catch {
        password.value = "";
        status.textContent = Tools.i18n.t("admin_login_failed");
      } finally {
        submit.disabled = false;
        cancel.disabled = false;
      }
    });
    actions.append(cancel, submit);
    form.append(label, status, actions);
    panel.append(title, form);
  });
}

/** @param {AppToolsState} Tools */
export async function manageAdministrator(Tools) {
  const button = document.getElementById("adminSessionButton");
  const status = document.getElementById("adminSessionStatus");
  if (!(button instanceof HTMLButtonElement) || !status || button.disabled)
    return;
  button.disabled = true;
  status.textContent = "";
  try {
    const url = new URL("../api/admin", window.location.href);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Admin access failed");
    const access = await response.json();
    if (!access.enabled) {
      status.textContent = Tools.i18n.t("admin_login_unavailable");
      return;
    }
    if (access.authenticated) {
      const confirmed = await showConfirmDialog({
        title: Tools.i18n.t("administrator"),
        message: Tools.i18n.t("admin_signed_in"),
        confirmLabel: Tools.i18n.t("admin_sign_out"),
        cancelLabel: Tools.i18n.t("cancel"),
      });
      if (!confirmed) return;
      const logout = await fetch(url, {
        method: "DELETE",
        headers: { "x-wbo-admin": "1" },
      });
      if (!logout.ok) throw new Error("Admin sign out failed");
      window.location.reload();
    } else if (await signIn(Tools, url)) window.location.reload();
  } catch {
    status.textContent = Tools.i18n.t("admin_login_failed");
  } finally {
    button.disabled = false;
  }
}
