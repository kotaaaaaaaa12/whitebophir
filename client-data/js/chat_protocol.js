export const CHAT_PAGE_SIZE = 50;
export const CHAT_MAX_LENGTH = 1000;
const FORBIDDEN_CHARACTERS = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;

/** @typedef {{id: number, name: string, text: string, sentAt: number}} ChatMessage */
/** @typedef {ChatMessage & {own?: boolean}} ChatLiveMessage */
/** @typedef {{messages: ChatMessage[], nextBefore: number | null}} ChatPage */
/** @typedef {{author: string, clientId: string, name: string, text: string, sentAt: number}} ChatInput */
/** @typedef {{ok: true, message: ChatMessage} | {ok: false, error: string}} ChatSendResult */
/** @typedef {{ok: true, id: number} | {ok: false, error: string}} ChatDeleteResult */
/** @typedef {({ok: true, canDelete?: boolean} & ChatPage) | {ok: false, error: string}} ChatHistoryResult */

/** @param {unknown} value @returns {string | null} */
export function normalizeChatText(value) {
  if (typeof value !== "string" || value.length > CHAT_MAX_LENGTH * 2)
    return null;
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (
    !text ||
    [...text].length > CHAT_MAX_LENGTH ||
    FORBIDDEN_CHARACTERS.test(text.replace(/[\n\t]/g, ""))
  )
    return null;
  return text;
}

/** @param {unknown} value @returns {value is string} */
export function validChatClientId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

/** @param {unknown} value @returns {value is ChatInput} */
export function validChatInput(value) {
  if (!value || typeof value !== "object") return false;
  const input = /** @type {Partial<ChatInput>} */ (value);
  return (
    typeof input.author === "string" &&
    /^[0-9a-f]{64}$/.test(input.author) &&
    validChatClientId(input.clientId) &&
    typeof input.name === "string" &&
    input.name.length > 0 &&
    input.name.length <= 160 &&
    !FORBIDDEN_CHARACTERS.test(input.name) &&
    typeof input.text === "string" &&
    normalizeChatText(input.text) === input.text &&
    Number.isSafeInteger(input.sentAt) &&
    Number(input.sentAt) > 0 &&
    Number(input.sentAt) <= 8_640_000_000_000_000
  );
}

/** @param {unknown} value @returns {value is ChatMessage} */
export function validChatMessage(value) {
  if (!value || typeof value !== "object") return false;
  const message = /** @type {Partial<ChatMessage>} */ (value);
  return (
    Number.isSafeInteger(message.id) &&
    Number(message.id) > 0 &&
    typeof message.name === "string" &&
    message.name.length > 0 &&
    message.name.length <= 160 &&
    !FORBIDDEN_CHARACTERS.test(message.name) &&
    typeof message.text === "string" &&
    normalizeChatText(message.text) === message.text &&
    Number.isSafeInteger(message.sentAt) &&
    Number(message.sentAt) > 0 &&
    Number(message.sentAt) <= 8_640_000_000_000_000
  );
}

/** @param {unknown} value @returns {value is number} */
export function validChatCursor(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
