import { derived, get, writable } from "svelte/store";
import en from "./en.json";
import ja from "./ja.json";

export type LanguagePreference = "auto" | "ja" | "en";
export type Locale = "ja" | "en";
export type MessageId = keyof typeof en;
export type Parameters = Record<string, string | number>;
export const LANGUAGE_KEY = "beatbump-language";
const inBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const validPreference = (value: unknown): value is LanguagePreference =>
	value === "auto" || value === "ja" || value === "en";

export function browserLocale(languages: readonly string[]): Locale {
	// The primary preferred language decides; secondary Japanese does not override English.
	return /^ja(?:-|$)/i.test(languages[0] ?? "") ? "ja" : "en";
}

function readPreference(): LanguagePreference {
	try {
		const value = inBrowser ? localStorage.getItem(LANGUAGE_KEY) : null;
		return validPreference(value) ? value : "auto";
	} catch { return "auto"; }
}
const preference = writable<LanguagePreference>(readPreference());
const detected = writable<Locale>(inBrowser ? browserLocale(navigator.languages?.length ? navigator.languages : [navigator.language]) : "en");
export const languagePreference = { subscribe: preference.subscribe };
export const locale = derived([preference, detected], ([choice, automatic]) => choice === "auto" ? automatic : choice);

export function setLanguage(value: LanguagePreference): void {
	if (!validPreference(value)) return;
	preference.set(value);
	if (inBrowser) {
		try { localStorage.setItem(LANGUAGE_KEY, value); } catch { /* Private browsing may deny storage. */ }
	}
}

export function translateFor(language: Locale, message: string, params: Parameters = {}): string {
	const catalog: Record<string, string> = language === "ja" ? ja : en;
	if (language === "en" && message === "{count} songs" && Number(params.count) === 1) message = "{count} song";
	const template = Object.prototype.hasOwnProperty.call(catalog, message) ? catalog[message] : message;
	return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] === undefined ? match : String(params[key]));
}
export const t = derived(locale, language => (message: string | undefined, params: Parameters = {}) => translateFor(language, message ?? "", params));
// Upstream section labels vary in capitalization and whitespace. Keep this
// normalization confined to headings so song and artist titles stay untouched.
const normalizeHeading = (value: string) => value.trim().replace(/\s+/g, " ").replace(/[’‘]/g, "'").replace(/&/g, "and").replace(/[.!?:]+$/, "").toLowerCase();
const headingKeys = new Map(Object.keys(en).map(key => [normalizeHeading(key), key]));
// Compose only known structural labels, rather than translating arbitrary titles.
const headingCollections: Record<string, string> = {
	playlists: "Playlists", albums: "Albums", artists: "Artists", songs: "Songs", tracks: "Songs",
	videos: "Videos", "music videos": "Music Videos", mixes: "Mixes", singles: "Singles", releases: "Releases",
};
const headingModifiers: Record<string, string> = {
	featured: "Featured {collection}", trending: "Trending {collection}", popular: "Popular {collection}",
	recommended: "Recommended {collection}", new: "New {collection}", top: "Top {collection}",
	"recently added": "Recently added {collection}", "recently played": "Recently played {collection}",
};
const personalizedHeadings: readonly [RegExp, string][] = [
	[/^featuring (.+)$/i, "Featuring {artist}"],
	[/^similar to (.+)$/i, "Similar to {artist}"],
	[/^more like (.+)$/i, "More like {artist}"],
	[/^more from (.+)$/i, "More from {artist}"],
	[/^because you listened to (.+)$/i, "Because you listened to {artist}"],
	[/^because you like (.+)$/i, "Because you like {artist}"],
	[/^fans of (.+) might like$/i, "Fans of {artist} might like"],
	[/^fans of (.+) also like$/i, "Fans of {artist} also like"],
	[/^based on (.+)$/i, "Based on {artist}"],
];
export function translateSectionHeadingFor(language: Locale, value: string | undefined): string {
	const original = value ?? "";
	if (language === "en") return original;
	const text = original.trim().replace(/\s+/g, " ");
	const key = headingKeys.get(normalizeHeading(text));
	if (key) return translateFor(language, key);
	const collection = /^(featured|trending|popular|recommended|new|top|recently added|recently played) (community |featured )?(playlists|albums|artists|songs|tracks|music videos|videos|mixes|singles|releases)( for you)?$/.exec(normalizeHeading(text));
	if (collection) {
		const [, modifier, qualifier, kind, personalized] = collection;
		const base = qualifier ? translateFor(language, `${qualifier.trim()[0].toUpperCase()}${qualifier.trim().slice(1)} ${headingCollections[kind]}`) : translateFor(language, headingCollections[kind]);
		const heading = translateFor(language, headingModifiers[modifier], { collection: base });
		return personalized ? translateFor(language, "For you: {heading}", { heading }) : heading;
	}
	for (const [pattern, message] of personalizedHeadings) {
		const match = pattern.exec(text);
		if (match) return translateFor(language, message, { artist: match[1] });
	}
	// Unknown server labels remain readable rather than disappearing.
	return original;
}
export const sectionHeading = derived(locale, language => (value: string | undefined) => translateSectionHeadingFor(language, value));

export function translateMetadataFor(language: Locale, value: unknown): string {
	const text = String(value ?? "");
	if (language === "en") return text;
	const kinds: Record<string, string> = { song: "Song", album: "Album", single: "Single", ep: "EP", playlist: "Playlist", video: "Video", "music video": "Music video" };
	const units: Record<string, string> = { song: "songs", track: "tracks", view: "views", subscriber: "subscribers", play: "plays", hour: "hours", hr: "hours", minute: "minutes", min: "minutes", second: "seconds", sec: "seconds", playlist: "playlists", listener: "listeners", like: "likes", album: "albums", artist: "artists", video: "videos", year: "years", month: "months", week: "weeks", day: "days" };
	return text.split(/(\s*[•·]\s*)/).map(part => {
		const trimmed = part.trim();
		const kind = Object.prototype.hasOwnProperty.call(kinds, trimmed.toLowerCase()) ? kinds[trimmed.toLowerCase()] : undefined;
		if (kind) return part.replace(trimmed, translateFor(language, kind));
		const count = /^([\d,.]+[KMB]?)\s+(monthly listeners?|songs?|tracks?|views?|subscribers?|plays?|hours?|hrs?|minutes?|mins?|seconds?|secs?|playlists?|listeners?|likes?|albums?|artists?|videos?|years?|months?|weeks?|days?)( ago)?$/i.exec(trimmed);
		if (!count) return part;
		const singular = count[2].toLowerCase().replace(/s$/, "");
		const unit = singular === "monthly listener" ? "monthly listeners" : units[singular];
		return part.replace(trimmed, translateFor(language, `{count} ${unit}${count[3] ? " ago" : ""}`, { count: count[1] }));
	}).join("");
}
// Only structural metadata uses this formatter; song/artist names never do.
export const metadata = derived(locale, language => (value: unknown) => translateMetadataFor(language, value));
export const translate = (message: string, params: Parameters = {}) => translateFor(get(locale), message, params);

// Worker notifications arrive on the main thread as English messages. Match catalog
// templates without changing the worker's protocol or persisting translated data.
const messageTemplates = Object.keys(en).filter(key => /\{\w+\}/.test(key)).map(key => {
	const names: string[] = [];
	const escaped = key.split(/(\{\w+\})/).map(part => {
		if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return "(.+?)"; }
		return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}).join("");
	return { key, names, pattern: new RegExp("^" + escaped + "$") };
});
export function translateMessage(message: unknown): string {
	const text = String(message ?? "");
	if (Object.prototype.hasOwnProperty.call(en, text)) return translate(text);
	for (const template of messageTemplates) {
		const match = template.pattern.exec(text);
		if (match) return translate(template.key, Object.fromEntries(template.names.map((name, index) => [name, name === "reason" ? errorMessage(match[index + 1]) : match[index + 1]])));
	}
	return text;
}
export const message = derived(locale, () => (value: unknown, isError = false) => isError ? errorMessage(value) : translateMessage(value));

export function errorMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error ?? "");
	const localized = translateMessage(text);
	if (localized !== text || Object.prototype.hasOwnProperty.call(en, text)) return localized;
	return translate(/network|fetch|connection|timeout/i.test(text) ? "Network error. Please try again." : "An error occurred. Please try again.");
}

if (inBrowser) {
	preference.subscribe(value => {
		try { document.cookie = LANGUAGE_KEY + "=" + value + "; Path=/; Max-Age=31536000; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : ""); } catch { /* The startup page also reads localStorage. */ }
	});
	locale.subscribe(language => { document.documentElement.lang = language; });
	window.addEventListener("languagechange", () => {
		detected.set(browserLocale(navigator.languages?.length ? navigator.languages : [navigator.language]));
	});
	window.addEventListener("storage", event => {
		if (event.key === LANGUAGE_KEY || event.key === null) preference.set(readPreference());
	});
}
