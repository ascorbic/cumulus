import type { Config } from "./config.ts";

export const CACHE_CONTROL = {
	day: "public, max-age=86400",
	negative: "public, max-age=300",
	noStore: "no-store",
} as const;

const SECURITY_HEADERS = {
	"content-security-policy": "default-src 'none'; sandbox",
	"x-content-type-options": "nosniff",
	"cross-origin-resource-policy": "cross-origin",
} as const;

export function blobTags(did: string, cid: string): string[] {
	return [`did:${did.toLowerCase()}`, `cid:${cid.toLowerCase()}`];
}

export interface ErrorOptions {
	status: number;
	cacheControl: string;
	tags?: string[];
	message: string;
	extraHeaders?: Record<string, string>;
}

export function errorResponse({
	status,
	cacheControl,
	tags,
	message,
	extraHeaders,
}: ErrorOptions): Response {
	const headers = new Headers({
		...SECURITY_HEADERS,
		...extraHeaders,
		"content-type": "text/plain; charset=utf-8",
		"cache-control": cacheControl,
	});
	if (tags && tags.length > 0) headers.set("cache-tag", tags.join(","));
	return new Response(message, { status, headers });
}

export function redirectResponse(location: string): Response {
	return errorResponse({
		status: 301,
		cacheControl: CACHE_CONTROL.day,
		message: `Moved to ${location}`,
		extraHeaders: { location },
	});
}

export function blobResponse(
	bytes: Uint8Array,
	{ did, cid, mime, ext }: { did: string; cid: string; mime: string; ext: string },
	config: Config,
): Response {
	return new Response(bytes, {
		status: 200,
		headers: {
			...SECURITY_HEADERS,
			"content-type": mime,
			"content-length": String(bytes.byteLength),
			"cache-control": `public, max-age=${config.browserMaxAge}`,
			"cloudflare-cdn-cache-control": `max-age=${config.edgeMaxAge}, immutable`,
			"cache-tag": blobTags(did, cid).join(","),
			"content-disposition": `inline; filename="${cid}.${ext}"`,
		},
	});
}
