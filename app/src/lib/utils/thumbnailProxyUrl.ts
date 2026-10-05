import type { Thumbnail } from "$lib/types";

const imageHosts = new Set([
	"i.ytimg.com", "img.youtube.com", "yt3.ggpht.com", "yt3.googleusercontent.com",
	"lh3.googleusercontent.com", "lh4.googleusercontent.com",
]);

/** Use the same image route for live metadata and images saved by older versions. */
export function thumbnailProxyUrl(origin: string, value: string): string {
	try {
		let source = new URL(value, origin);
		if (source.pathname === "/api/v1/image") {
			const raw = source.searchParams.get("url");
			const id = source.searchParams.get("id");
			if (raw !== null) source = new URL(raw);
			else if (id) {
				if (id.length > 11000 || !/^[A-Za-z0-9_-]+$/.test(id)) return value;
				const encoded = id.replace(/-/g, "+").replace(/_/g, "/");
				const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), c => c.charCodeAt(0));
				source = new URL(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			}
		}
		if (source.protocol !== "https:" || source.username || source.password || source.port ||
			source.hash || !imageHosts.has(source.hostname)) return value;
		const bytes = new TextEncoder().encode(source.href);
		if (bytes.length > 8192) return value;
		const id = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
			.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		return `${new URL(origin).origin}/api/v1/image?id=${id}`;
	} catch {
		return value;
	}
}

export const proxyUrls = (origin: string) => (thumbnail: Thumbnail) => {
	if (thumbnail.url) thumbnail.url = thumbnailProxyUrl(origin, thumbnail.url);
	if (thumbnail.placeholder) thumbnail.placeholder = thumbnailProxyUrl(origin, thumbnail.placeholder);
	if (thumbnail.original_url) thumbnail.original_url = thumbnailProxyUrl(origin, thumbnail.original_url);
	return thumbnail;
};

/** Normalize saved image metadata without changing records in browser storage. */
export function proxyImageMetadata<T>(value: T, origin: string): T {
	const visited = new WeakSet<object>();
	const visit = (item: unknown): unknown => {
		if (typeof item === "string") return thumbnailProxyUrl(origin, item);
		if (!item || typeof item !== "object" || visited.has(item)) return item;
		if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null) return item;
		visited.add(item);
		for (const key of Object.keys(item)) {
			const record = item as Record<string, unknown>;
			record[key] = visit(record[key]);
		}
		return item;
	};
	return visit(value) as T;
}
