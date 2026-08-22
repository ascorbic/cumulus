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

export function didTag(did: string): string {
	return `did:${did.toLowerCase()}`;
}

export function cidTag(cid: string): string {
	return `cid:${cid.toLowerCase()}`;
}

export function blobTags(did: string, cid: string): string[] {
	return [didTag(did), cidTag(cid)];
}

export function versionTag(env: Pick<Env, "VERSION">): string {
	return `v:${env.VERSION.id}`;
}

const CACHE_UNAVAILABLE: CachePurgeResult = {
	success: false,
	errors: [{ code: 0, message: "ctx.cache is not available in this runtime" }],
};

export function purgeTags(ctx: ExecutionContext, tags: string[]): Promise<CachePurgeResult> {
	if (!ctx.cache) return Promise.resolve(CACHE_UNAVAILABLE);
	return ctx.cache.purge({ tags });
}

export function purgeEverything(ctx: ExecutionContext): Promise<CachePurgeResult> {
	if (!ctx.cache) return Promise.resolve(CACHE_UNAVAILABLE);
	return ctx.cache.purge({ purgeEverything: true });
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

export function jsonResponse(
	body: unknown,
	{
		status = 200,
		cacheControl,
		edgeCacheControl,
		tags,
	}: { status?: number; cacheControl: string; edgeCacheControl?: string; tags?: string[] },
): Response {
	const headers = new Headers({
		...SECURITY_HEADERS,
		"content-type": "application/json",
		"cache-control": cacheControl,
	});
	if (edgeCacheControl) headers.set("cloudflare-cdn-cache-control", edgeCacheControl);
	if (tags && tags.length > 0) headers.set("cache-tag", tags.join(","));
	return new Response(JSON.stringify(body), { status, headers });
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
	{ cid, mime, ext, tags }: { cid: string; mime: string; ext: string; tags: string[] },
	config: Config,
): Response {
	return new Response(bytes, {
		status: 200,
		headers: {
			...SECURITY_HEADERS,
			"content-type": mime,
			"content-length": String(bytes.byteLength),
			"accept-ranges": "bytes",
			"cache-control": `public, max-age=${config.browserMaxAge}`,
			"cloudflare-cdn-cache-control": `max-age=${config.edgeMaxAge}, immutable`,
			"cache-tag": tags.join(","),
			"content-disposition": `inline; filename="${cid}.${ext}"`,
		},
	});
}
