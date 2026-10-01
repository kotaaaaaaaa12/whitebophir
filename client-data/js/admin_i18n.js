/** @type {Record<string, Record<string, string>>} */
export const ADMIN_TRANSLATIONS = {
  en: {
    page_title: "All boards — WBO Administrator",
    administrator: "WBO Administrator",
    all_boards: "All boards",
    navigation: "Administrator navigation",
    home: "Home",
    sign_out: "Sign out",
    language: "Language",
    automatic: "Auto",
    checking_access: "Checking administrator access…",
    sign_in_title: "Administrator sign in",
    sign_in_hint:
      "Sign in to view and manage all saved and newly created boards.",
    admin_key: "Board admin key",
    sign_in: "Sign in",
    catalog: "Board catalog",
    search_names: "Search board names",
    search: "Search",
    refresh: "Refresh",
    catalog_hint:
      "Private boards are visible only to administrators here. Open a board to edit or clear its drawings.",
    board: "Board",
    actions: "Actions",
    no_boards: "No matching boards.",
    load_more: "Load more",
    delete_title: "Delete board",
    delete_warning:
      "Delete this board and all saved drawings? This cannot be undone. Everyone viewing it will return to the home page. Its old URL cannot be reused.",
    cancel: "Cancel",
    protected: "Public / protected",
    open: "Open",
    open_board: "Open {name}",
    delete: "Delete",
    delete_board: "Delete {name}",
    protected_hint:
      "Public and default boards cannot be deleted. Open the board to clear its drawings.",
    deleting: "Deleting board…",
    deleted: "Board deleted.",
    delete_failed_http: "Deletion failed (HTTP {status}).",
    delete_failed: "The board could not be deleted. Please try again.",
    board_count: "Boards loaded: {count}",
    loading: "Loading boards…",
    access_expired: "Administrator access expired. Sign in again.",
    list_failed_http: "The board list could not be loaded (HTTP {status}).",
    list_failed: "The board list could not be loaded. Please try again.",
    invalid_list: "Invalid board list response.",
    access_failed_http:
      "Administrator access could not be checked (HTTP {status}).",
    access_failed:
      "Administrator access could not be checked. Please try again.",
    access_disabled:
      "Set the WBO_BOARD_ADMIN_KEY Worker Secret and redeploy to enable administrator access.",
    signing_in: "Signing in…",
    rate_limited: "Too many sign in attempts. Try again in one minute.",
    login_failed: "Sign in failed. Check the board admin key and try again.",
    cookies_required:
      "Sign in could not be saved. Allow cookies for this site and try again.",
    logout_failed: "Sign out failed. Please try again.",
    signed_out: "Signed out.",
  },
  ja: {
    page_title: "すべてのボード — WBO 管理者",
    administrator: "WBO 管理者",
    all_boards: "すべてのボード",
    navigation: "管理メニュー",
    home: "ホーム",
    sign_out: "ログアウト",
    language: "表示言語",
    automatic: "自動",
    checking_access: "管理者権限を確認しています…",
    sign_in_title: "管理者ログイン",
    sign_in_hint:
      "ログインすると、保存済みのボードや新しく作られたボードをすべて確認・管理できます。",
    admin_key: "管理パスワード",
    sign_in: "ログイン",
    catalog: "ボード一覧",
    search_names: "ボード名を検索",
    search: "検索",
    refresh: "更新",
    catalog_hint:
      "この画面で非公開ボードを確認できるのは管理者だけです。ボードを開くと、描画の編集や全消去ができます。",
    board: "ボード",
    actions: "操作",
    no_boards: "該当するボードはありません。",
    load_more: "もっと読み込む",
    delete_title: "ボードを削除",
    delete_warning:
      "このボードと保存されたすべての描画を削除しますか？この操作は元に戻せません。閲覧中のユーザーはホームに戻ります。削除後は同じURLを再利用できません。",
    cancel: "キャンセル",
    protected: "公開 / 削除不可",
    open: "開く",
    open_board: "{name}を開く",
    delete: "削除",
    delete_board: "{name}を削除",
    protected_hint:
      "公開ボードと既定のボードは削除できません。描画を全消去するには、ボードを開いてください。",
    deleting: "ボードを削除しています…",
    deleted: "ボードを削除しました。",
    delete_failed_http: "ボードを削除できませんでした（HTTP {status}）。",
    delete_failed: "ボードを削除できませんでした。もう一度お試しください。",
    board_count: "{count}件のボードを表示中",
    loading: "ボードを読み込んでいます…",
    access_expired:
      "管理者権限の有効期限が切れました。もう一度ログインしてください。",
    list_failed_http: "ボード一覧を読み込めませんでした（HTTP {status}）。",
    list_failed: "ボード一覧を読み込めませんでした。もう一度お試しください。",
    invalid_list: "ボード一覧の応答が正しくありません。",
    access_failed_http: "管理者権限を確認できませんでした（HTTP {status}）。",
    access_failed: "管理者権限を確認できませんでした。もう一度お試しください。",
    access_disabled:
      "管理者ログインを有効にするには、WorkerのシークレットにWBO_BOARD_ADMIN_KEYを設定して再デプロイしてください。",
    signing_in: "ログインしています…",
    rate_limited:
      "ログイン試行回数が多すぎます。1分後にもう一度お試しください。",
    login_failed:
      "ログインできませんでした。管理パスワードを確認して、もう一度お試しください。",
    cookies_required:
      "ログイン状態を保存できませんでした。このサイトのCookieを許可して、もう一度お試しください。",
    logout_failed: "ログアウトできませんでした。もう一度お試しください。",
    signed_out: "ログアウトしました。",
  },
};

/** @param {string} preference @param {readonly string[]} languages @returns {"en" | "ja"} */
export function resolveAdminLanguage(preference, languages) {
  if (preference === "en" || preference === "ja") return preference;
  return /^ja(?:-|$)/i.test(languages[0] || "") ? "ja" : "en";
}

/** @param {string} language @param {string} key @param {Record<string, string | number>} [values] */
export function adminText(language, key, values = {}) {
  const text =
    ADMIN_TRANSLATIONS[language]?.[key] || ADMIN_TRANSLATIONS.en?.[key] || key;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}
