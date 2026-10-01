export {};

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
  name.textContent = board.name;
  if (board.protected) {
    const badge = document.createElement("span");
    badge.className = "protected-label";
    badge.textContent = "Public / protected";
    name.appendChild(badge);
  }
  const actionsCell = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "board-actions";
  const open = document.createElement("a");
  open.className = "open-board";
  open.textContent = "Open";
  open.href = apiUrl(`boards/${encodeURIComponent(board.name)}`).href;
  open.target = "_blank";
  open.rel = "noopener";
  open.setAttribute("aria-label", `Open ${board.name}`);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "Delete";
  remove.setAttribute("aria-label", `Delete ${board.name}`);
  remove.disabled = board.protected;
  if (board.protected)
    remove.title =
      "Public and default boards cannot be deleted. Open the board to clear its drawings.";
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      if (!(await confirmDeletion(board.name))) return;
      status.textContent = "Deleting board…";
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
        throw new Error(`Deletion failed (HTTP ${response.status}).`);
      }
      row.remove();
      updateCount();
      status.textContent = "Board deleted.";
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "The board could not be deleted.";
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
  count.textContent = `${rows.children.length} boards loaded`;
  empty.hidden = rows.children.length !== 0;
}

/** @param {boolean} [reset] */
async function loadBoards(reset = true) {
  if (!authenticated || loading) return;
  loading = true;
  more.disabled = refresh.disabled = true;
  status.textContent = "Loading boards…";
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
      status.textContent = "Administrator access expired. Sign in again.";
      return;
    }
    if (!response.ok)
      throw new Error(
        `The board list could not be loaded (HTTP ${response.status}).`,
      );
    const page = await response.json();
    if (!authenticated) return;
    if (!Array.isArray(page.boards))
      throw new Error("Invalid board list response.");
    if (reset) rows.replaceChildren();
    for (const board of page.boards) addBoard(board);
    nextCursor = page.nextCursor || "";
    more.hidden = !nextCursor;
    updateCount();
    status.textContent = "";
  } catch (error) {
    status.textContent =
      error instanceof Error
        ? error.message
        : "The board list could not be loaded.";
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
      throw new Error(
        `Administrator access could not be checked (HTTP ${response.status}).`,
      );
    const access = await response.json();
    const wasAuthenticated = authenticated;
    setAuthenticated(access.authenticated === true);
    if (!access.enabled)
      status.textContent =
        "Set the WBO_BOARD_ADMIN_KEY Worker Secret and redeploy to enable administrator access.";
    else if (!authenticated)
      status.textContent = wasAuthenticated
        ? "Administrator access expired. Sign in again."
        : "";
    else if (!wasAuthenticated) await loadBoards();
  } catch (error) {
    setAuthenticated(false);
    status.textContent =
      error instanceof Error
        ? error.message
        : "Administrator access could not be checked.";
  } finally {
    checkingAccess = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector("button");
  if (submit) submit.disabled = true;
  status.textContent = "Signing in…";
  try {
    const response = await fetch(apiUrl("api/admin"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-wbo-admin": "1" },
      body: JSON.stringify({ password: password.value }),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "Too many sign in attempts. Try again in one minute."
          : "Sign in failed. Check the board admin key and try again.",
      );
    password.value = "";
    await checkAccess();
    if (!authenticated)
      status.textContent =
        "Sign in could not be saved. Allow cookies for this site and try again.";
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Sign in failed.";
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
    if (!response.ok) throw new Error("Sign out failed.");
    setAuthenticated(false);
    status.textContent = "Signed out.";
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Sign out failed.";
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
