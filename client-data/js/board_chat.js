import {
  CHAT_MAX_LENGTH,
  normalizeChatText,
  validChatMessage,
  validChatCursor,
} from "./chat_protocol.js";
import { SocketEvents } from "./socket_events.js";

/** @import { AppToolsState, AppSocket } from "../../types/app-runtime" */
/** @import { ChatMessage, ChatPage, ChatSendResult, ChatHistoryResult, ChatDeleteResult } from "./chat_protocol.js" */

const CHAT_ERRORS = new Set([
  "chat_unavailable",
  "chat_invalid",
  "chat_rate_limited",
  "chat_verification_required",
  "chat_history_failed",
  "chat_send_failed",
  "chat_delete_failed",
  "chat_delete_forbidden",
]);

/** @template T @param {AppSocket} socket @param {string} event @param {object} payload @returns {Promise<T>} */
function request(socket, event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error("Chat socket is offline"));
      return;
    }
    const timeout = window.setTimeout(
      () => reject(new Error("Chat request timed out")),
      35_000,
    );
    socket.emit(event, payload, (/** @type {T} */ result) => {
      window.clearTimeout(timeout);
      resolve(result);
    });
  });
}

/** @param {unknown} result @returns {result is ChatPage & {ok: true}} */
function validPage(result) {
  if (!result || typeof result !== "object") return false;
  const page = /** @type {Partial<ChatPage> & {ok?: unknown}} */ (result);
  return (
    page.ok === true &&
    Array.isArray(page.messages) &&
    page.messages.length <= 50 &&
    page.messages.every(validChatMessage) &&
    (page.nextBefore === null || validChatCursor(page.nextBefore))
  );
}

export class BoardChat {
  /** @param {() => AppToolsState} getTools */
  constructor(getTools) {
    this.getTools = getTools;
    this.isOpen = false;
    this.loaded = false;
    this.loading = false;
    this.sending = false;
    this.canDelete = false;
    this.deletedIds = new Set();
    this.pendingDeletes = new Set();
    this.nextBefore = /** @type {number | null} */ (null);
    this.pending = /** @type {{text: string, clientId: string} | null} */ (
      null
    );
    this.messages = /** @type {Map<number, ChatMessage>} */ (new Map());
    this.boundSockets = new WeakSet();
    this.generation = 0;
    this.sendGeneration = 0;
    this.toggle = /** @type {HTMLButtonElement} */ (
      document.getElementById("boardChatToggle")
    );
    this.panel = document.createElement("section");
    this.panel.id = "boardChatPanel";
    this.panel.className = "board-chat-panel";
    this.panel.hidden = true;
    this.panel.dir = document.documentElement.dataset.uiDirection || "ltr";
    this.panel.setAttribute("aria-labelledby", "boardChatTitle");
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.id = "boardChatTitle";
    title.textContent = getTools().i18n.t("chat_title");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", getTools().i18n.t("chat_close"));
    close.addEventListener("click", () => {
      this.close();
      this.toggle.focus({ preventScroll: true });
    });
    header.append(title, close);
    const board = document.createElement("p");
    board.className = "board-chat-context";
    board.dir = "auto";
    board.textContent = getTools().identity.boardName;
    this.older = document.createElement("button");
    this.older.type = "button";
    this.older.textContent = getTools().i18n.t("chat_older");
    this.older.hidden = true;
    this.older.addEventListener("click", () => {
      void this.loadHistory(this.nextBefore);
    });
    this.list = document.createElement("ol");
    this.list.className = "board-chat-messages";
    this.list.setAttribute("role", "log");
    this.list.setAttribute("aria-label", getTools().i18n.t("chat_title"));
    this.list.setAttribute("aria-relevant", "additions");
    this.status = document.createElement("p");
    this.status.className = "board-chat-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.form = document.createElement("form");
    this.form.className = "board-chat-form";
    this.input = document.createElement("textarea");
    this.input.id = "boardChatInput";
    this.input.rows = 2;
    this.input.maxLength = CHAT_MAX_LENGTH * 2;
    this.input.placeholder = getTools().i18n.t("chat_placeholder");
    this.input.setAttribute(
      "aria-label",
      getTools().i18n.t("chat_placeholder"),
    );
    this.input.dir = "auto";
    this.send = document.createElement("button");
    this.send.type = "submit";
    this.send.textContent = getTools().i18n.t("chat_send");
    this.form.append(this.input, this.send);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendMessage();
    });
    this.input.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    this.panel.append(
      header,
      board,
      this.older,
      this.list,
      this.status,
      this.form,
    );
    document.body.append(this.panel);
    // Keep chat typing and taps separate from board shortcuts and drawing tools.
    this.panel.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        this.toggle.focus({ preventScroll: true });
      }
    });
    for (const type of [
      "keyup",
      "pointerdown",
      "pointerup",
      "touchstart",
      "touchmove",
      "touchend",
      "wheel",
    ])
      this.panel.addEventListener(type, (event) => event.stopPropagation());
    document.addEventListener("pointerdown", (event) => {
      if (
        this.isOpen &&
        event.target instanceof Node &&
        !this.panel.contains(event.target) &&
        !this.toggle.contains(event.target) &&
        !(
          event.target instanceof Element &&
          event.target.closest("dialog[open]")
        )
      )
        this.close();
    });
    const fit = () => {
      if (this.isOpen) this.position();
    };
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("scroll", fit);
    const socket = getTools().connection.socket;
    if (socket) this.attachSocket(socket);
  }

  position() {
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft || 0,
      y = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth,
      height = viewport?.height || innerHeight;
    const anchor = this.toggle.getBoundingClientRect();
    const rail = document.getElementById("menu")?.getBoundingClientRect();
    const leftBound = Math.max(x + 8, (rail?.right || x) + 8);
    const availableWidth = Math.max(0, x + width - 8 - leftBound);
    this.panel.style.width = `${Math.min(340, availableWidth)}px`;
    const top = Math.max(y + 8, Math.min(anchor.bottom + 8, y + height - 180));
    this.panel.style.left = `${Math.max(leftBound, Math.min(anchor.right - this.panel.offsetWidth, x + width - this.panel.offsetWidth - 8))}px`;
    this.panel.style.top = `${top}px`;
    this.panel.style.height = `${Math.max(0, Math.min(420, y + height - top - 8))}px`;
  }

  open() {
    this.getTools().presence.setConnectedUsersPanelOpen(false);
    this.isOpen = true;
    this.panel.hidden = false;
    this.toggle.setAttribute("aria-expanded", "true");
    this.getTools().presence.markChatRead();
    this.position();
    this.syncConnection();
    if (!this.loaded) void this.loadHistory();
    this.list.scrollTop = this.list.scrollHeight;
  }

  close() {
    this.isOpen = false;
    this.panel.hidden = true;
    this.toggle.setAttribute("aria-expanded", "false");
  }

  /** @param {string} key */
  showStatus(key) {
    this.status.textContent = key ? this.getTools().i18n.t(key) : "";
  }

  syncConnection() {
    const Tools = this.getTools();
    const ready =
      Tools.connection.socket?.connected === true &&
      Tools.presence.users.has(Tools.connection.socket.id || "");
    this.send.disabled =
      !ready || this.sending || Tools.access.canReport === false;
    if (!ready) this.showStatus("chat_unavailable");
    return ready;
  }

  /** @param {AppSocket} socket */
  attachSocket(socket) {
    if (this.boundSockets.has(socket)) return;
    this.boundSockets.add(socket);
    socket.on(SocketEvents.CHAT_DELETED, (message) => {
      if (
        socket === this.getTools().connection.socket &&
        validChatCursor(message?.id)
      )
        this.receiveDeleted(message.id);
    });
    socket.on(SocketEvents.CHAT_MESSAGE, (message) => {
      if (
        socket === this.getTools().connection.socket &&
        validChatMessage(message)
      )
        this.receive(message);
    });
    socket.on(SocketEvents.BOARDSTATE, () => {
      if (socket !== this.getTools().connection.socket) return;
      this.syncConnection();
      if (this.isOpen || this.loaded) void this.loadHistory();
    });
    socket.on(SocketEvents.DISCONNECT, () => {
      this.generation++;
      this.sendGeneration++;
      this.sending = false;
      this.loading = false;
      this.older.disabled = false;
      this.syncConnection();
    });
  }

  /** @param {ChatMessage} message */
  receive(message) {
    if (this.messages.has(message.id) || this.deletedIds.has(message.id))
      return;
    const atBottom =
      this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight <
      40;
    this.messages.set(message.id, message);
    this.render();
    if (this.status.textContent === this.getTools().i18n.t("chat_empty"))
      this.showStatus("");
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  /** @param {number} id */
  receiveDeleted(id) {
    this.deletedIds.add(id);
    this.messages.delete(id);
    this.render();
    if (this.messages.size === 0) this.showStatus("chat_empty");
  }

  /** @param {ChatMessage} message */
  async deleteMessage(message) {
    if (!this.canDelete || this.pendingDeletes.has(message.id)) return;
    this.pendingDeletes.add(message.id);
    this.render();
    const Tools = this.getTools();
    try {
      if (
        !(await Tools.ui.confirm({
          title: Tools.i18n.t("chat_delete"),
          message: `${Tools.i18n.t("chat_delete_confirm")}\n\n${message.name}: ${message.text}`,
          confirmLabel: Tools.i18n.t("chat_delete"),
          cancelLabel: Tools.i18n.t("cancel"),
          variant: "danger",
        }))
      )
        return;
      const socket = Tools.connection.socket;
      if (!socket || !this.syncConnection()) {
        this.showStatus("chat_unavailable");
        return;
      }
      const result = /** @type {ChatDeleteResult} */ (
        await request(socket, SocketEvents.CHAT_DELETE, { id: message.id })
      );
      if (result?.ok && result.id === message.id) {
        this.receiveDeleted(result.id);
        this.showStatus(this.messages.size === 0 ? "chat_empty" : "");
      } else {
        const error =
          result && !result.ok && CHAT_ERRORS.has(result.error)
            ? result.error
            : "chat_delete_failed";
        if (error === "chat_delete_forbidden") this.canDelete = false;
        this.showStatus(error);
      }
    } catch {
      this.showStatus("chat_delete_failed");
    } finally {
      this.pendingDeletes.delete(message.id);
      this.render();
    }
  }

  render() {
    const fragment = document.createDocumentFragment();
    for (const message of [...this.messages.values()].sort(
      (a, b) => a.id - b.id,
    )) {
      const row = document.createElement("li");
      row.dataset.messageId = String(message.id);
      const meta = document.createElement("div");
      meta.className = "board-chat-meta";
      const name = document.createElement("bdi");
      name.textContent = message.name;
      const time = document.createElement("time");
      const date = new Date(message.sentAt);
      time.dateTime = date.toISOString();
      time.textContent = new Intl.DateTimeFormat(
        document.documentElement.lang || "en",
        { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
      ).format(date);
      meta.append(name, time);
      const text = document.createElement("p");
      text.dir = "auto";
      text.textContent = message.text;
      row.append(meta, text);
      if (this.canDelete) {
        row.classList.add("board-chat-message-manageable");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "board-chat-delete";
        button.setAttribute(
          "aria-label",
          this.getTools().i18n.t("chat_delete"),
        );
        button.title = this.getTools().i18n.t("chat_delete");
        button.disabled = this.pendingDeletes.has(message.id);
        const svg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "16");
        svg.setAttribute("height", "16");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.5");
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute(
          "d",
          "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
        );
        svg.append(path);
        button.append(svg);
        button.addEventListener("click", () => {
          void this.deleteMessage(message);
        });
        row.append(button);
      }
      fragment.append(row);
    }
    this.list.replaceChildren(fragment);
  }

  /** @param {number | null} [before] */
  async loadHistory(before = null) {
    const socket = this.getTools().connection.socket;
    if (this.loading || !socket || !this.syncConnection()) return;
    const generation = ++this.generation;
    this.loading = true;
    this.older.disabled = true;
    this.showStatus("chat_loading");
    const scrollTop = this.list.scrollTop,
      scrollHeight = this.list.scrollHeight;
    if (before === null) {
      this.messages.clear();
      this.render();
    }
    try {
      const page = /** @type {ChatHistoryResult} */ (
        await request(
          socket,
          SocketEvents.CHAT_HISTORY,
          before === null ? {} : { before },
        )
      );
      if (generation !== this.generation) return;
      if (page && !page.ok) {
        this.loaded = false;
        this.showStatus(
          CHAT_ERRORS.has(page.error) ? page.error : "chat_history_failed",
        );
        return;
      }
      if (!validPage(page)) throw new Error("Invalid chat history response");
      this.canDelete = page.canDelete === true;
      for (const message of page.messages)
        if (!this.deletedIds.has(message.id))
          this.messages.set(message.id, message);
      this.nextBefore = page.nextBefore;
      this.loaded = true;
      this.render();
      this.older.hidden = this.nextBefore === null;
      this.list.scrollTop =
        before === null
          ? this.list.scrollHeight
          : scrollTop + this.list.scrollHeight - scrollHeight;
      this.showStatus(this.messages.size === 0 ? "chat_empty" : "");
    } catch {
      if (generation === this.generation) {
        this.loaded = false;
        this.showStatus("chat_history_failed");
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.older.disabled = false;
      }
    }
  }

  async sendMessage() {
    const socket = this.getTools().connection.socket;
    if (this.sending || !socket || !this.syncConnection()) return;
    const text = normalizeChatText(this.input.value);
    if (text === null) {
      this.showStatus("chat_invalid");
      return;
    }
    if (!this.pending || this.pending.text !== text)
      this.pending = { text, clientId: crypto.randomUUID() };
    const pending = this.pending;
    const generation = ++this.sendGeneration;
    this.sending = true;
    this.send.disabled = true;
    this.showStatus("chat_sending");
    try {
      const result = /** @type {ChatSendResult} */ (
        await request(socket, SocketEvents.CHAT_SEND, pending)
      );
      if (generation !== this.sendGeneration) return;
      if (!result?.ok || !validChatMessage(result.message)) {
        this.showStatus(
          result && !result.ok && CHAT_ERRORS.has(result.error)
            ? result.error
            : "chat_send_failed",
        );
        return;
      }
      this.receive(result.message);
      // Preserve anything typed while the request was in flight.
      if (normalizeChatText(this.input.value) === pending.text)
        this.input.value = "";
      this.pending = null;
      this.showStatus("");
      this.list.scrollTop = this.list.scrollHeight;
    } catch {
      if (generation === this.sendGeneration)
        this.showStatus("chat_send_failed");
    } finally {
      if (generation === this.sendGeneration) {
        this.sending = false;
        this.syncConnection();
      }
    }
  }
}
