import { normalizeRecentBoards } from "./board_page_state.js";
import { showModalDialog } from "./board_ui_module.js";

/** @import { AppToolsState } from "../../types/app-runtime" */

/** @param {string} name */
export function leaveDeletedBoard(name) {
  try {
    const boards = normalizeRecentBoards(
      JSON.parse(localStorage.getItem("recent-boards") || "[]"),
    );
    localStorage.setItem(
      "recent-boards",
      JSON.stringify(boards.filter((board) => board !== name)),
    );
  } catch {
    // Redirect even when browser storage is unavailable.
  }
  window.location.replace(new URL("../", window.location.href).href);
}

/** @param {AppToolsState} Tools @param {boolean} needsAdminKey */
function confirmBoardDeletion(Tools, needsAdminKey) {
  return showModalDialog(
    /** @type {{adminKey: string} | null} */ (null),
    (panel, settle) => {
      const title = document.createElement("div");
      title.className = "wbo-dialog-title";
      title.id = "delete-board-title";
      panel.closest("dialog")?.setAttribute("aria-labelledby", title.id);
      title.textContent = Tools.i18n.t("delete_board");
      const message = document.createElement("div");
      message.className = "wbo-dialog-message";
      message.textContent = `${Tools.identity.boardName}\n${Tools.i18n.t("delete_board_warning")}`;
      const form = document.createElement("form");
      const key = document.createElement("input");
      if (needsAdminKey) {
        const label = document.createElement("label");
        label.textContent = Tools.i18n.t("board_admin_key");
        key.type = "password";
        key.autocomplete = "off";
        key.maxLength = 256;
        key.required = true;
        label.appendChild(key);
        form.appendChild(label);
      }
      const actions = document.createElement("div");
      actions.className = "wbo-dialog-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "wbo-dialog-button wbo-dialog-button-secondary";
      cancel.textContent = Tools.i18n.t("cancel");
      cancel.addEventListener("click", () => settle(null));
      const confirm = document.createElement("button");
      confirm.type = "submit";
      confirm.className = "wbo-dialog-button wbo-dialog-button-danger";
      confirm.textContent = Tools.i18n.t("delete_board");
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        settle({ adminKey: key.value });
      });
      actions.append(cancel, confirm);
      form.appendChild(actions);
      panel.append(title, message, form);
      cancel.focus();
    },
  );
}

/** @param {AppToolsState} Tools */
export async function deleteCurrentBoard(Tools) {
  const button = document.getElementById("deleteBoardButton");
  const status = document.getElementById("deleteBoardStatus");
  if (!(button instanceof HTMLButtonElement) || !status || button.disabled)
    return;
  button.disabled = true;
  status.textContent = "";
  try {
    const url = new URL(
      `../api/boards/${encodeURIComponent(Tools.identity.boardName)}`,
      window.location.href,
    );
    if (Tools.identity.token)
      url.searchParams.set("token", Tools.identity.token);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Board access failed");
    const access = await response.json();
    if (access.protected) {
      status.textContent = Tools.i18n.t("delete_board_protected");
      return;
    }
    if (!access.canDelete && !access.adminKeyEnabled) {
      status.textContent = Tools.i18n.t("delete_board_owner_required");
      return;
    }
    const confirmed = await confirmBoardDeletion(Tools, !access.canDelete);
    if (!confirmed) return;
    status.textContent = Tools.i18n.t("deleting_board");
    const deleted = await fetch(url, {
      method: "DELETE",
      headers: {
        "x-wbo-delete": "1",
        ...(confirmed.adminKey
          ? { "x-board-admin-key": confirmed.adminKey }
          : {}),
      },
    });
    if (!deleted.ok) {
      status.textContent = Tools.i18n.t(
        deleted.status === 403 ? "delete_board_denied" : "delete_board_failed",
      );
      return;
    }
    leaveDeletedBoard(Tools.identity.boardName);
  } catch {
    status.textContent = Tools.i18n.t("delete_board_failed");
  } finally {
    button.disabled = false;
  }
}
