import { CID_PATTERN } from "./cid.ts";
import type { Config } from "./config.ts";
import { parseBlobPath } from "./path.ts";
import { CACHE_CONTROL, blobTags, errorResponse, recordTag, versionTag } from "./response.ts";
import { parseScopedPath } from "./scoped.ts";

/**
 * Bluesky's appview presets (packages/bsky/src/image/uri.ts). `min: true`
 * there permits upscaling, which is the binding's `contain`, not `scale-down`.
 */
export const PRESETS = {
	avatar: { fit: "cover", width: 1000, height: 1000 },
	banner: { fit: "cover", width: 3000, height: 1000 },
	feed_thumbnail: { fit: "contain", width: 2000, height: 2000 },
	feed_fullsize: { fit: "contain", width: 1000, height: 1000 },
} as const satisfies Record<string, ImageTransform>;

export type Preset = keyof typeof PRESETS;

export const FORMATS = {
	webp: "image/webp",
	jpeg: "image/jpeg",
	png: "image/png",
} as const;

export type Format = keyof typeof FORMATS;

const EXTENSIONS: Record<Format, string> = { webp: "webp", jpeg: "jpg", png: "png" };

export interface ImgTarget {
	preset: Preset;
	format: Format | undefined;
	did: string;
	cid: string;
	/** The original's path on this Worker, for the loopback. */
	original: string;
	tags: string[];
}

export type ImgPath =
	| ({ kind: "img" } & ImgTarget)
	| { kind: "redirect"; location: string }
	| { kind: "invalid" }
	| { kind: "unknown" };

function isPreset(value: string): value is Preset {
	return Object.hasOwn(PRESETS, value);
}

function isFormat(value: string): value is Format {
	return Object.hasOwn(FORMATS, value);
}

/**
 * `/img/{preset}/plain/{did}/{cid}[@{format}]` (open mode) or
 * `/img/{preset}/r/{did}/{collection}/{rkey}/{cid}[@{format}]` (scoped mode),
 * canonicalised like the underlying blob path.
 */
export function parseImgPath(pathname: string, mode: "open" | "scoped"): ImgPath {
	const match = /^\/img\/([^/]+)\/(plain|r)(\/.+?)(?:@([^/@]*))?$/.exec(pathname);
	if (!match) return { kind: "unknown" };
	const [, preset, source, rest, suffix] = match as unknown as [
		string,
		string,
		"plain" | "r",
		string,
		string | undefined,
	];
	if ((mode === "open") !== (source === "plain")) return { kind: "unknown" };
	if (!isPreset(preset)) return { kind: "invalid" };
	const format = suffix === undefined ? undefined : suffix.toLowerCase();
	if (format !== undefined && !isFormat(format)) return { kind: "invalid" };
	const formatSuffix = format ? `@${format}` : "";

	if (source === "plain") {
		const blob = parseBlobPath(rest);
		if (blob.kind !== "blob" && blob.kind !== "redirect") return { kind: "invalid" };
		const canonicalRest = blob.kind === "blob" ? rest : blob.location;
		const canonical = `/img/${preset}/plain${canonicalRest}${formatSuffix}`;
		if (canonical !== pathname) return { kind: "redirect", location: canonical };
		const [did, cid] = canonicalRest.slice(1).split("/") as [string, string];
		if (!CID_PATTERN.test(cid)) return { kind: "invalid" };
		return {
			kind: "img",
			preset,
			format,
			did,
			cid,
			original: canonicalRest,
			tags: blobTags(did, cid),
		};
	}

	const scoped = parseScopedPath(`/r${rest}`);
	if (scoped.kind !== "scoped" && scoped.kind !== "redirect") return { kind: "invalid" };
	const canonicalRest = scoped.kind === "scoped" ? `/r${rest}` : scoped.location;
	const canonical = `/img/${preset}${canonicalRest}${formatSuffix}`;
	if (canonical !== pathname) return { kind: "redirect", location: canonical };
	if (scoped.kind !== "scoped") return { kind: "invalid" };
	return {
		kind: "img",
		preset,
		format,
		did: scoped.did,
		cid: scoped.cid,
		original: canonicalRest,
		tags: [
			...blobTags(scoped.did, scoped.cid),
			recordTag(scoped.did, scoped.collection, scoped.rkey),
		],
	};
}

export function transformOptions(preset: Preset): ImageTransform {
	return { ...PRESETS[preset] };
}

export function outputOptions(format: Format | undefined): ImageOutputOptions {
	const mime = FORMATS[format ?? "webp"];
	return mime === "image/webp" ? { format: mime, anim: true } : { format: mime };
}

/**
 * Serves a preset variant derived from the verified original via loopback.
 * The original is fetched and verified once and shared by every variant;
 * variants carry the same tags, so one purge clears original and derived.
 */
export async function serveImg(
	target: ImgTarget,
	env: Env,
	ctx: ExecutionContext,
	config: Config,
): Promise<Response> {
	const images = (env as { IMAGES?: ImagesBinding }).IMAGES;
	if (!images) {
		return errorResponse({
			status: 404,
			cacheControl: CACHE_CONTROL.negative,
			message: "Image presets are not enabled",
		});
	}
	const original = await ctx.exports.default.fetch(`http://self${target.original}`);
	if (original.status !== 200 || !original.body) return original;
	const format = target.format ?? "webp";
	let result: ImageTransformationResult;
	try {
		result = await images
			.input(original.body)
			.transform(transformOptions(target.preset))
			.output(outputOptions(target.format));
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "transform-failed",
				did: target.did,
				cid: target.cid,
				preset: target.preset,
				detail: String(error),
			}),
		);
		return errorResponse({
			status: 502,
			cacheControl: CACHE_CONTROL.noStore,
			message: `Image transform failed: ${(error as Error).message}`,
		});
	}
	const bytes = new Uint8Array(await new Response(result.image()).arrayBuffer());
	return new Response(bytes, {
		status: 200,
		headers: {
			"content-type": result.contentType(),
			"content-length": String(bytes.byteLength),
			"accept-ranges": "bytes",
			"cache-control": `public, max-age=${config.browserMaxAge}`,
			"cloudflare-cdn-cache-control": `max-age=${config.edgeMaxAge}, immutable`,
			"cache-tag": [...target.tags, versionTag(env)].join(","),
			"content-disposition": `inline; filename="${target.cid}.${EXTENSIONS[format]}"`,
			"content-security-policy": "default-src 'none'; sandbox",
			"x-content-type-options": "nosniff",
			"cross-origin-resource-policy": "cross-origin",
		},
	});
}
