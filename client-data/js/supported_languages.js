/** Native language names shared by the server-rendered selector and locale matcher. */
export const SUPPORTED_LANGUAGES = {
  ar: "العربية",
  be: "Беларуская",
  ca: "Català",
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  hu: "Magyar",
  id: "Bahasa Indonesia",
  it: "Italiano",
  ja: "日本語",
  my: "မြန်မာ",
  pt: "Português",
  ru: "Русский",
  sw: "Kiswahili",
  th: "ไทย",
  uk: "Українська",
  vi: "Tiếng Việt",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  pl: "Polski",
};

/** @param {string} tag @returns {string | undefined} */
export function matchSupportedLanguage(tag) {
  try {
    const locale = new Intl.Locale(tag.trim());
    if (locale.language === "zh") {
      // An explicit script takes precedence over a region (e.g. zh-Hans-HK).
      if (locale.script) return locale.script === "Hant" ? "zh-TW" : "zh-CN";
      return ["TW", "HK", "MO"].includes(locale.region || "")
        ? "zh-TW"
        : "zh-CN";
    }
    if (
      Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, locale.language)
    )
      return locale.language;
  } catch {
    // Ignore unsupported or malformed preferences and try the next language.
  }
  return undefined;
}

/**
 * @param {string} tag
 * @returns {string}
 */
function canonicalizeLocale(tag) {
  const trimmed = tag.trim();
  if (!trimmed || trimmed === "*") return trimmed;
  try {
    return new Intl.Locale(trimmed).toString();
  } catch {
    return trimmed;
  }
}

/**
 * @param {string} header
 * @returns {{tag: string, quality: number}[]}
 */
export function parseAcceptLanguage(header) {
  return header
    .split(",")
    .map(function parsePart(part, index) {
      const [rawTag, ...rawParams] = part.split(";");
      const tag = canonicalizeLocale(rawTag || "");
      if (!tag) return null;
      let quality = 1;
      for (const rawParam of rawParams) {
        const [key, value] = rawParam.split("=");
        if (key && key.trim() === "q") {
          const parsed = Number.parseFloat((value || "").trim());
          quality = Number.isFinite(parsed) ? parsed : 0;
        }
      }
      return { tag, quality, index };
    })
    .filter(
      /**
       * @param {{tag: string, quality: number, index: number} | null} language
       * @returns {language is {tag: string, quality: number, index: number}}
       */
      function isSupported(language) {
        return language !== null && language.quality > 0;
      },
    )
    .sort(function compareLanguages(a, b) {
      if (b.quality !== a.quality) return b.quality - a.quality;
      return a.index - b.index;
    })
    .map(function stripIndex(language) {
      return { tag: language.tag, quality: language.quality };
    });
}
