const test = require("node:test");
const assert = require("node:assert/strict");
const translations =
  /** @type {Record<string, Record<string, string>> & {en: Record<string, string>}} */ (
    require("../server/http/translations.json")
  );

const boardKeys = [
  "display_name",
  "save_display_name",
  "display_name_hint",
  "display_name_invalid",
  "display_name_saved",
  "display_name_not_saved",
  "display_name_retry",
  "delete_board",
  "delete_board_warning",
  "board_admin_key",
  "delete_board_protected",
  "delete_board_owner_required",
  "deleting_board",
  "delete_board_denied",
  "delete_board_failed",
  "custom_color",
  "color_hex",
  "color_red",
  "color_green",
  "color_blue",
  "color_apply",
  "administrator",
  "admin_sign_in",
  "admin_sign_out",
  "admin_signed_in",
  "admin_login_unavailable",
  "admin_login_failed",
  "admin_login_rate_limited",
  "admin_all_boards",
];

/** @param {string} text */
const placeholders = (text) =>
  [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();

test("every supported language has all added board, dashboard and startup translations with intact placeholders", async () => {
  const { ADMIN_TRANSLATIONS, adminText } = await import(
    "../client-data/js/admin_i18n.js"
  );
  const { SUPPORTED_LANGUAGES } = await import(
    "../client-data/js/supported_languages.js"
  );
  const { STARTUP_TRANSLATIONS } = await import(
    "../client-data/js/startup_i18n.js"
  );
  const languages = Object.keys(translations).sort();
  assert.equal(languages.length, 21);
  for (const catalog of [
    SUPPORTED_LANGUAGES,
    ADMIN_TRANSLATIONS,
    STARTUP_TRANSLATIONS,
  ])
    assert.deepEqual(Object.keys(catalog).sort(), languages);
  for (const language of languages) {
    const board = translations[language];
    assert.ok(board);
    for (const key of boardKeys) {
      assert.ok(
        typeof board[key] === "string" && board[key].trim(),
        `${language}: ${key}`,
      );
      assert.deepEqual(
        placeholders(board[key]),
        placeholders(translations.en[key] || ""),
      );
    }
    const admin = ADMIN_TRANSLATIONS[language];
    assert.ok(admin);
    assert.deepEqual(
      Object.keys(admin).sort(),
      Object.keys(ADMIN_TRANSLATIONS.en || {}).sort(),
    );
    for (const [key, value] of Object.entries(admin)) {
      assert.ok(value.trim(), `${language}: admin.${key}`);
      assert.deepEqual(
        placeholders(value),
        placeholders(ADMIN_TRANSLATIONS.en?.[key] || ""),
        `${language}: admin.${key}`,
      );
    }
    assert.equal(admin.all_boards, board.admin_all_boards);
    assert.equal(admin.delete_title, board.delete_board);
    assert.equal(admin.admin_key, board.board_admin_key);
    assert.equal(
      adminText(language, "open_board", { name: "<私のボード>" }),
      admin.open_board?.replace("{name}", "<私のボード>"),
    );
    assert.equal(
      adminText(language, "board_count", { count: 0 }),
      admin.board_count?.replace("{count}", "0"),
    );
    assert.equal(
      adminText(language, "delete_failed_http", { status: 503 }),
      admin.delete_failed_http?.replace("{status}", "503"),
    );
    if (language !== "en") {
      for (const key of [
        "display_name_hint",
        "delete_board_warning",
        "admin_signed_in",
      ])
        assert.notEqual(
          board[key],
          translations.en[key],
          `${language}: untranslated ${key}`,
        );
      for (const key of [
        "sign_in_hint",
        "catalog_hint",
        "delete_warning",
        "cookies_required",
      ])
        assert.notEqual(
          admin[key],
          ADMIN_TRANSLATIONS.en?.[key],
          `${language}: untranslated admin.${key}`,
        );
      assert.notEqual(STARTUP_TRANSLATIONS[language], STARTUP_TRANSLATIONS.en);
    }
  }
});

test("language matching respects explicit choices, preference order, regions and Chinese scripts", async () => {
  const { resolveAdminLanguage } = await import(
    "../client-data/js/admin_i18n.js"
  );
  const { matchSupportedLanguage, parseAcceptLanguage } = await import(
    "../client-data/js/supported_languages.js"
  );
  for (const language of Object.keys(translations))
    assert.equal(resolveAdminLanguage(language, ["ja-JP"]), language);
  for (const [tag, expected] of /** @type {[string, string][]} */ ([
    ["fr-CA", "fr"],
    ["PT-br", "pt"],
    ["ar-EG", "ar"],
    ["be-BY", "be"],
    ["zh-Hant", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-Hant-CN", "zh-TW"],
    ["zh-SG", "zh-CN"],
    ["zh", "zh-CN"],
  ]))
    assert.equal(matchSupportedLanguage(tag), expected, tag);
  assert.equal(resolveAdminLanguage("auto", ["ko-KR", "fr-CA", "ja-JP"]), "fr");
  assert.equal(resolveAdminLanguage("auto", ["unsupported", "ar-EG"]), "ar");
  assert.equal(resolveAdminLanguage("auto", []), "en");
  for (const tag of [
    "auto",
    "",
    "__proto__",
    "constructor",
    "not/a-locale",
    "ko-KR",
  ])
    assert.equal(matchSupportedLanguage(tag), undefined);
  assert.deepEqual(
    parseAcceptLanguage("ja;q=0,ko-KR;q=1,zh-Hant;q=0.9,fr;q=0.8"),
    [
      { tag: "ko-KR", quality: 1 },
      { tag: "zh-Hant", quality: 0.9 },
      { tag: "fr", quality: 0.8 },
    ],
  );
});

test("startup messages follow an explicit language or the weighted supported request preferences", async () => {
  const { startupMessage, STARTUP_TRANSLATIONS } = await import(
    "../client-data/js/startup_i18n.js"
  );
  for (const language of Object.keys(translations))
    assert.deepEqual(
      startupMessage(`https://wbo.test/?lang=${language}`, "en"),
      { language, message: STARTUP_TRANSLATIONS[language] },
    );
  assert.equal(
    startupMessage("https://wbo.test/", "ja;q=0,ko-KR,zh-Hant;q=0.9").language,
    "zh-TW",
  );
  assert.equal(
    startupMessage("https://wbo.test/?lang=auto", "fr-CA").language,
    "fr",
  );
  assert.equal(
    startupMessage("https://wbo.test/?lang=garbage", "ar-EG").language,
    "ar",
  );
  assert.equal(startupMessage("https://wbo.test/", "ko-KR").language, "en");
});
