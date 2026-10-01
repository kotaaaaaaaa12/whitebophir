import { adminText, resolveAdminLanguage } from "./admin_i18n.js";
import { matchSupportedLanguage } from "./supported_languages.js";

/** @param {string} id @returns {HTMLElement} */
function element(id) {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement))
    throw new Error(`Missing admin element: ${id}`);
  return node;
}

const status = element("adminStatus");
const loginPanel = element("adminLogin");
const manager = element("adminManager");
const loginForm = /** @type {HTMLFormElement} */ (element("adminLoginForm"));
const password = /** @type {HTMLInputElement} */ (element("adminPassword"));
const logout = /** @type {HTMLButtonElement} */ (element("adminLogout"));
const searchForm = /** @type {HTMLFormElement} */ (element("boardSearchForm"));
const search = /** @type {HTMLInputElement} */ (element("boardSearch"));
const refresh = /** @type {HTMLButtonElement} */ (element("refreshBoards"));
const more = /** @type {HTMLButtonElement} */ (element("loadMoreBoards"));
const rows = element("boardRows");
const count = element("boardCount");
const empty = element("emptyBoards");
const dialog = /** @type {HTMLDialogElement} */ (element("deleteBoardDialog"));
const languageControl = /** @type {HTMLSelectElement} */ (
  element("adminLanguage")
);
const LANGUAGE_KEY = "wbo.adminLanguage";
const requestedLanguage = new URL(window.location.href).searchParams.get(
  "lang",
);
let languagePreference = requestedLanguage
  ? matchSupportedLanguage(requestedLanguage) || "auto"
  : "auto";
if (!requestedLanguage) {
  try {
    languagePreference = localStorage.getItem(LANGUAGE_KEY) || "auto";
  } catch {
    languagePreference = "auto";
  }
}
languagePreference = matchSupportedLanguage(languagePreference) || "auto";
let language = resolveAdminLanguage(languagePreference, navigator.languages);
languageControl.value = languagePreference;

/** @param {string} key @param {Record<string, string | number>} [values] */
const t = (key, values = {}) => adminText(language, key, values);

/**
 * @param {HTMLElement} node @param {string} key
 * @param {Record<string, string | number>} [values] @param {string} [attribute]
 */
function translated(node, key, values = {}, attribute = "") {
  node.dataset.i18nValues = JSON.stringify(values);
  if (attribute) {
    node.setAttribute(`data-i18n-${attribute}`, key);
    node.setAttribute(attribute, t(key, values));
  } else {
    node.dataset.i18n = key;
    node.textContent = t(key, values);
  }
}

/** @param {string} [key] @param {Record<string, string | number>} [values] */
function showStatus(key = "", values = {}) {
  if (key) translated(status, key, values);
  else {
    delete status.dataset.i18n;
    status.textContent = "";
  }
}

class AdminPageError extends Error {
  /** @param {string} key @param {Record<string, string | number>} [values] */
  constructor(key, values = {}) {
    super(key);
    this.key = key;
    this.values = values;
  }
}

/** @param {unknown} error @param {string} fallback */
function showError(error, fallback) {
  if (error instanceof AdminPageError) showStatus(error.key, error.values);
  else showStatus(fallback);
}

function localizePage() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.title = t("page_title");
  for (const node of document.querySelectorAll(
    "[data-i18n], [data-i18n-aria-label], [data-i18n-placeholder], [data-i18n-title]",
  )) {
    if (!(node instanceof HTMLElement)) continue;
    const values = JSON.parse(node.dataset.i18nValues || "{}");
    if (node.dataset.i18n) node.textContent = t(node.dataset.i18n, values);
    for (const attribute of ["aria-label", "placeholder", "title"]) {
      const key = node.getAttribute(`data-i18n-${attribute}`);
      if (key) node.setAttribute(attribute, t(key, values));
    }
  }
  for (const node of document.querySelectorAll("a.open-board, #adminHome")) {
    if (!(node instanceof HTMLAnchorElement)) continue;
    const url = new URL(node.href);
    url.searchParams.set("lang", language);
    node.href = url.href;
  }
}

languageControl.addEventListener("change", () => {
  languagePreference = languageControl.value;
  language = resolveAdminLanguage(languagePreference, navigator.languages);
  try {
    localStorage.setItem(LANGUAGE_KEY, languagePreference);
  } catch {
    // The current page can still switch language without browser storage.
  }
  const url = new URL(window.location.href);
  if (languagePreference === "auto") url.searchParams.delete("lang");
  else url.searchParams.set("lang", languagePreference);
  window.history.replaceState(null, "", url);
  localizePage();
});
localizePage();

let authenticated = false;
let loading = false;
let checkingAccess = false;
let nextCursor = "";
let query = "";

/** @param {string} path */
const apiUrl = (path) => new URL(path, document.baseURI);

/** @param {boolean} active */
function setAuthenticated(active) {
  authenticated = active;
  manager.hidden = !active;
  logout.hidden = !active;
  loginPanel.hidden = active;
  if (!active) {
    rows.replaceChildren();
    count.textContent = "";
    delete count.dataset.i18n;
    more.hidden = true;
    if (dialog.open) dialog.close("cancel");
  }
}

/** @param {string} name @returns {Promise<boolean>} */
function confirmDeletion(name) {
  element("deleteBoardName").textContent = name;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "delete"),
      { once: true },
    );
    dialog.showModal();
  });
}

/** @param {{name: string, protected: boolean}} board */
function addBoard(board) {
  const row = document.createElement("tr");
  const name = document.createElement("td");
  name.className = "board-name";
  const boardName = document.createElement("bdi");
  boardName.textContent = board.name;
  name.appendChild(boardName);
  if (board.protected) {
    const badge = document.createElement("span");
    badge.className = "protected-label";
    translated(badge, "protected");
    name.appendChild(badge);
  }
  const actionsCell = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "board-actions";
  const open = document.createElement("a");
  open.className = "open-board";
  translated(open, "open");
  const boardUrl = apiUrl(`boards/${encodeURIComponent(board.name)}`);
  boardUrl.searchParams.set("lang", language);
  open.href = boardUrl.href;
  open.target = "_blank";
  open.rel = "noopener";
  translated(open, "open_board", { name: board.name }, "aria-label");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  translated(remove, "delete");
  translated(remove, "delete_board", { name: board.name }, "aria-label");
  remove.disabled = board.protected;
  if (board.protected)
    translated(remove, "protected_hint", { name: board.name }, "title");
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      if (!(await confirmDeletion(board.name))) return;
      showStatus("deleting");
      const response = await fetch(
        apiUrl(`api/boards/${encodeURIComponent(board.name)}`),
        {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "x-wbo-delete": "1" },
        },
      );
      if (!response.ok) {
        if (response.status === 403) await checkAccess();
        throw new AdminPageError("delete_failed_http", {
          status: response.status,
        });
      }
      row.remove();
      updateCount();
      showStatus("deleted");
    } catch (error) {
      showError(error, "delete_failed");
    } finally {
      remove.disabled = board.protected;
    }
  });
  actions.append(open, remove);
  actionsCell.appendChild(actions);
  row.append(name, actionsCell);
  rows.appendChild(row);
}

function updateCount() {
  translated(count, "board_count", { count: rows.children.length });
  empty.hidden = rows.children.length !== 0;
}

/** @param {boolean} [reset] */
async function loadBoards(reset = true) {
  if (!authenticated || loading) return;
  loading = true;
  more.disabled = refresh.disabled = true;
  showStatus("loading");
  const url = apiUrl("api/admin/boards");
  url.searchParams.set("q", query);
  if (!reset && nextCursor) url.searchParams.set("after", nextCursor);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 403) {
      setAuthenticated(false);
      showStatus("access_expired");
      return;
    }
    if (!response.ok)
      throw new AdminPageError("list_failed_http", { status: response.status });
    const page = await response.json();
    if (!authenticated) return;
    if (!Array.isArray(page.boards)) throw new AdminPageError("invalid_list");
    if (reset) rows.replaceChildren();
    for (const board of page.boards) addBoard(board);
    nextCursor = page.nextCursor || "";
    more.hidden = !nextCursor;
    updateCount();
    showStatus();
  } catch (error) {
    showError(error, "list_failed");
  } finally {
    loading = false;
    more.disabled = refresh.disabled = false;
  }
}

async function checkAccess() {
  if (checkingAccess) return;
  checkingAccess = true;
  try {
    const response = await fetch(apiUrl("api/admin"), {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new AdminPageError("access_failed_http", {
        status: response.status,
      });
    const access = await response.json();
    const wasAuthenticated = authenticated;
    setAuthenticated(access.authenticated === true);
    if (!access.enabled) showStatus("access_disabled");
    else if (!authenticated)
      showStatus(wasAuthenticated ? "access_expired" : "");
    else if (!wasAuthenticated) await loadBoards();
  } catch (error) {
    setAuthenticated(false);
    showError(error, "access_failed");
  } finally {
    checkingAccess = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector("button");
  if (submit) submit.disabled = true;
  showStatus("signing_in");
  try {
    const response = await fetch(apiUrl("api/admin"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-wbo-admin": "1" },
      body: JSON.stringify({ password: password.value }),
    });
    if (!response.ok)
      throw new AdminPageError(
        response.status === 429 ? "rate_limited" : "login_failed",
      );
    password.value = "";
    await checkAccess();
    if (!authenticated) showStatus("cookies_required");
  } catch (error) {
    showError(error, "login_failed");
  } finally {
    if (submit) submit.disabled = false;
  }
});

logout.addEventListener("click", async () => {
  logout.disabled = true;
  try {
    const response = await fetch(apiUrl("api/admin"), {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "x-wbo-admin": "1" },
    });
    if (!response.ok) throw new AdminPageError("logout_failed");
    setAuthenticated(false);
    showStatus("signed_out");
  } catch (error) {
    showError(error, "logout_failed");
  } finally {
    logout.disabled = false;
  }
});
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (loading) return;
  query = search.value.trim();
  void loadBoards();
});
refresh.addEventListener("click", () => void loadBoards());
more.addEventListener("click", () => void loadBoards(false));
// Check on return rather than polling, so an idle admin tab does not keep the
// Container awake. The API still verifies every operation independently.
window.addEventListener("focus", () => {
  if (authenticated) void checkAccess();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && authenticated) void checkAccess();
});
void checkAccess();
