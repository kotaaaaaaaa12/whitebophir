import {
  matchSupportedLanguage,
  parseAcceptLanguage,
} from "./supported_languages.js";

/** @type {Record<string, string>} */
export const STARTUP_TRANSLATIONS = {
  ar: "اللوحة قيد التشغيل أو غير متاحة مؤقتًا. يرجى المحاولة مجددًا.",
  be: "Дошка запускаецца або часова недаступная. Паспрабуйце яшчэ раз.",
  ca: "La pissarra s’està iniciant o no està disponible temporalment. Torna-ho a provar.",
  de: "Das Whiteboard startet gerade oder ist vorübergehend nicht verfügbar. Bitte versuche es erneut.",
  en: "The whiteboard is starting or temporarily unavailable. Please try again.",
  es: "La pizarra se está iniciando o no está disponible temporalmente. Inténtalo de nuevo.",
  fr: "Le tableau démarre ou est temporairement indisponible. Veuillez réessayer.",
  hu: "A tábla éppen indul, vagy átmenetileg nem érhető el. Próbáld újra.",
  id: "Papan sedang dimulai atau sementara tidak tersedia. Silakan coba lagi.",
  it: "La lavagna si sta avviando o è temporaneamente non disponibile. Riprova.",
  ja: "ホワイトボードを起動中、または一時的に利用できません。もう一度お試しください。",
  my: "ဘုတ် စတင်နေသည် သို့မဟုတ် ယာယီမသုံးနိုင်ပါ။ ထပ်မံကြိုးစားပါ။",
  pt: "O quadro está iniciando ou está temporariamente indisponível. Tente novamente.",
  ru: "Доска запускается или временно недоступна. Попробуйте ещё раз.",
  sw: "Ubao unaanza au haupatikani kwa muda. Tafadhali jaribu tena.",
  th: "กระดานกำลังเริ่มทำงานหรือไม่พร้อมใช้งานชั่วคราว โปรดลองอีกครั้ง",
  uk: "Дошка запускається або тимчасово недоступна. Спробуйте ще раз.",
  vi: "Bảng đang khởi động hoặc tạm thời không khả dụng. Vui lòng thử lại.",
  "zh-CN": "白板正在启动或暂时不可用。请重试。",
  "zh-TW": "白板正在啟動或暫時無法使用。請重試。",
  pl: "Tablica uruchamia się lub jest tymczasowo niedostępna. Spróbuj ponownie.",
};

/** @param {string} url @param {string} acceptLanguage */
export function startupMessage(url, acceptLanguage) {
  let language = matchSupportedLanguage(
    new URL(url).searchParams.get("lang") || "",
  );
  if (!language) {
    for (const { tag } of parseAcceptLanguage(acceptLanguage)) {
      language = matchSupportedLanguage(tag);
      if (language) break;
    }
  }
  language ||= "en";
  return {
    language,
    message: STARTUP_TRANSLATIONS[language] || STARTUP_TRANSLATIONS.en || "",
  };
}
