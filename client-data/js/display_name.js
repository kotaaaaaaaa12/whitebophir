export const MAX_DISPLAY_NAME_LENGTH = 32;

/**
 * Empty names restore the server-generated name. Names are never identity keys.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeDisplayName(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  if (/[\p{Cc}\p{Cs}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    return null;
  }
  const name = value.trim().replace(/\s+/gu, " ");
  return Array.from(name).length <= MAX_DISPLAY_NAME_LENGTH ? name : null;
}
