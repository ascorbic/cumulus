import { CID_PATTERN } from "./cid.ts";
import type { Config } from "./config.ts";
import { parseBlobPath } from "./path.ts";
import { CACHE_CONTROL, blobTags, errorResponse, versionTag } from "./response.ts";

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

export type ImgPath =
	| { kind: "img"; preset: Preset; did: string; cid: string; format: Format | undefined }
	| { kind: "redirect"; location: string }
	| { kind: "invalid" }
	| { kind: "unknown" };

function isPreset(value: string): value is Preset {
	return Object.hasOwn(PRESETS, value);
}

function isFormat(value: string): value is Format {
	return Object.hasOwn(FORMATS, value);
}

/** `/img/{preset}/plain/{did}/{cid}[@{format}]`, canonical or redirected like the blob path. */
export function parseImgPath(pathname: string): ImgPath {
	const match = /^\/img\/([^/]+)\/plain(\/.+?)(?:@([^/@]*))?$/.exec(pathname);
	if (!match) return { kind: "unknown" };
	const [, preset, rest, suffix] = match as unknown as [string, string, string, string | undefined];
	if (!isPreset(preset)) return { kind: "invalid" };
	const format = suffix === undefined ? undefined : suffix.toLowerCase();
	if (format !== undefined && !isFormat(format)) return { kind: "invalid" };
	const blob = parseBlobPath(rest);
	if (blob.kind !== "blob" && blob.kind !== "redirect") return { kind: "invalid" };
	const canonicalRest = blob.kind === "blob" ? rest : blob.location;
	const canonical = `/img/${preset}/plain${canonicalRest}${format ? `@${format}` : ""}`;
	if (canonical !== pathname) return { kind: "redirect", location: canonical };
	const [did, cid] = canonicalRest.slice(1).split("/") as [string, string];
	if (!CID_PATTERN.test(cid)) return { kind: "invalid" };
	return { kind: "img", preset, did, cid, format };
}

export function transformOptions(preset: Preset): ImageTransform {
	return { ...PRESETS[preset] };
}

export function outputOptions(format: Format | undefined): ImageOutputOptions {
	return { format: FORMATS[format ?? "webp"], anim: true };
}

/**
 * Serves a preset variant derived from the verified original via loopback.
 * The original is fetched and verified once and shared by every variant;
 * variants carry the same tags, so one purge clears original and derived.
 */
export async function serveImg(
	path: Extract<ImgPath, { kind: "img" }>,
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
	const original = await ctx.exports.default.fetch(`http://self/${path.did}/${path.cid}`);
	if (original.status !== 200 || !original.body) return original;
	const format = path.format ?? "webp";
	let result: ImageTransformationResult;
	try {
		result = await images
			.input(original.body)
			.transform(transformOptions(path.preset))
			.output(outputOptions(path.format));
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "transform-failed",
				did: path.did,
				cid: path.cid,
				preset: path.preset,
				detail: String(error),
			}),
		);
		return errorResponse({
			status: 502,
			cacheControl: CACHE_CONTROL.noStore,
			message: "Image transform failed",
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
			"cache-tag": [...blobTags(path.did, path.cid), versionTag(env)].join(","),
			"content-disposition": `inline; filename="${path.cid}.${EXTENSIONS[format]}"`,
			"content-security-policy": "default-src 'none'; sandbox",
			"x-content-type-options": "nosniff",
			"cross-origin-resource-policy": "cross-origin",
		},
	});
}
