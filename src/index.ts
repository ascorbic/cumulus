import indexHtml from "../site/index.html?raw";
import { handleAdmin } from "./admin.ts";
import { fetchBlob, sha256 } from "./blob.ts";
import { decodeBlobCid, digestsEqual } from "./cid.ts";
import { configHash, loadConfig, type Config } from "./config.ts";
import { imageInfo } from "./dimensions.ts";
import { drain } from "./drain.ts";
import { parseImgPath, serveImg } from "./img.ts";
import { drainJetstream } from "./jetstream.ts";
import { admit, parseScopedPath } from "./scoped.ts";
import { parseBlobPath } from "./path.ts";
import {
	CACHE_CONTROL,
	blobResponse,
	blobTags,
	didTag,
	errorResponse,
	jsonResponse,
	redirectResponse,
	versionTag,
} from "./response.ts";
import { EXTENSIONS, sniff } from "./sniff.ts";

export { Identity } from "./entrypoints/identity.ts";
export { Policy } from "./entrypoints/policy.ts";
export { Record } from "./entrypoints/record.ts";

type Resolution =
	| { kind: "pds"; pds: string }
	| { kind: "not-found" }
	| { kind: "error"; detail: string };

async function resolveIdentity(ctx: ExecutionContext, did: string): Promise<Resolution> {
	const response = await ctx.exports.Identity.fetch(`http://identity/did/${did}`);
	if (response.status === 404) return { kind: "not-found" };
	if (!response.ok) {
		return {
			kind: "error",
			detail: `Identity returned ${response.status}: ${await response.text()}`,
		};
	}
	const { pds } = (await response.json()) as { pds: string };
	return { kind: "pds", pds };
}

type PolicyResult =
	| { kind: "allow" }
	| { kind: "deny"; reason?: string }
	| { kind: "error"; detail: string };

async function checkPolicy(ctx: ExecutionContext, did: string, cid: string): Promise<PolicyResult> {
	const response = await ctx.exports.Policy.fetch(`http://policy/check/${did}/${cid}`);
	if (!response.ok) {
		return {
			kind: "error",
			detail: `Policy returned ${response.status}: ${await response.text()}`,
		};
	}
	const verdict = (await response.json()) as { allow: boolean; reason?: string };
	return verdict.allow ? { kind: "allow" } : { kind: "deny", reason: verdict.reason };
}

interface MissLog {
	event: "blob";
	did: string;
	cid: string;
	status: number;
	mime?: string;
	bytes?: number;
	verified?: boolean;
	identityMs?: number;
	policyMs?: number;
	upstreamMs?: number;
}

function logMiss(entry: MissLog, response: Response): Response {
	console.log(JSON.stringify({ ...entry, status: response.status }));
	return response;
}

async function serveBlob(
	did: string,
	cid: string,
	env: Env,
	ctx: ExecutionContext,
	config: Config,
	extraTags: string[] = [],
): Promise<Response> {
	const log: MissLog = { event: "blob", did, cid, status: 0 };
	let expectedDigest: Uint8Array;
	try {
		expectedDigest = decodeBlobCid(cid);
	} catch (error) {
		return logMiss(
			log,
			errorResponse({
				status: 400,
				cacheControl: CACHE_CONTROL.day,
				message: `Unsupported CID: ${(error as Error).message}`,
			}),
		);
	}
	const version = versionTag(env);
	const tags = [...blobTags(did, cid), ...extraTags, version];

	let started = Date.now();
	const identity = await resolveIdentity(ctx, did);
	log.identityMs = Date.now() - started;
	if (identity.kind === "error") {
		return logMiss(
			log,
			errorResponse({ status: 502, cacheControl: CACHE_CONTROL.noStore, message: identity.detail }),
		);
	}
	if (identity.kind === "not-found") {
		return logMiss(
			log,
			errorResponse({
				status: 404,
				cacheControl: CACHE_CONTROL.negative,
				tags: [didTag(did), ...extraTags, version],
				message: "DID not found or has no PDS",
			}),
		);
	}

	started = Date.now();
	const policy = await checkPolicy(ctx, did, cid);
	log.policyMs = Date.now() - started;
	if (policy.kind === "error") {
		return logMiss(
			log,
			errorResponse({ status: 502, cacheControl: CACHE_CONTROL.noStore, message: policy.detail }),
		);
	}
	if (policy.kind === "deny") {
		return logMiss(
			log,
			errorResponse({ status: 403, cacheControl: CACHE_CONTROL.day, tags, message: "Forbidden" }),
		);
	}

	started = Date.now();
	const blob = await fetchBlob(identity.pds, did, cid, {
		maxSize: config.blobMaxSize,
		timeoutMs: config.blobFetchTimeoutMs,
	});
	log.upstreamMs = Date.now() - started;
	switch (blob.status) {
		case "not-found":
			return logMiss(
				log,
				errorResponse({
					status: 404,
					cacheControl: CACHE_CONTROL.negative,
					tags,
					message: "Blob not found",
				}),
			);
		case "too-large":
			return logMiss(
				log,
				errorResponse({
					status: 413,
					cacheControl: CACHE_CONTROL.day,
					tags: [...tags, `cfg:${await configHash(env)}`],
					message: "Blob exceeds size limit",
				}),
			);
		case "upstream-error":
			return logMiss(
				log,
				errorResponse({ status: 502, cacheControl: CACHE_CONTROL.noStore, message: blob.detail }),
			);
	}

	log.bytes = blob.bytes.byteLength;
	log.verified = digestsEqual(await sha256(blob.bytes), expectedDigest);
	if (!log.verified) {
		console.error(
			JSON.stringify({ event: "cid-mismatch", did, cid, pds: identity.pds, bytes: log.bytes }),
		);
		return logMiss(
			log,
			errorResponse({
				status: 502,
				cacheControl: CACHE_CONTROL.noStore,
				message: "Blob failed CID verification",
			}),
		);
	}

	const type = sniff(blob.bytes);
	log.mime = type.mime;
	if (!config.allowedMimeTypes.has(type.mime)) {
		return logMiss(
			log,
			errorResponse({
				status: 415,
				cacheControl: CACHE_CONTROL.day,
				tags: [...tags, `cfg:${await configHash(env)}`],
				message: `Content type ${type.mime} is not allowed`,
			}),
		);
	}
	return logMiss(log, blobResponse(blob.bytes, { cid, ...type, tags }, config));
}

/**
 * Derives metadata from the verified original via a loopback to the blob
 * route, so the original is fetched and verified once and shared with every
 * derived response. Non-200 originals pass through with their own
 * Cache-Control and tags.
 */
async function serveMetadata(
	did: string,
	cid: string,
	env: Env,
	ctx: ExecutionContext,
	config: Config,
): Promise<Response> {
	const original = await ctx.exports.default.fetch(`http://self/${did}/${cid}`);
	if (original.status !== 200) return original;
	const bytes = new Uint8Array(await original.arrayBuffer());
	const mime = original.headers.get("content-type") ?? "application/octet-stream";
	return jsonResponse(
		{ mime, ext: EXTENSIONS[mime] ?? "bin", size: bytes.byteLength, ...imageInfo(bytes, mime) },
		{
			cacheControl: `public, max-age=${config.browserMaxAge}`,
			edgeCacheControl: `max-age=${config.edgeMaxAge}, immutable`,
			tags: [...blobTags(did, cid), versionTag(env)],
		},
	);
}

function withoutBody(response: Response): Response {
	return new Response(null, response);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/admin/")) {
			return handleAdmin(request, env, ctx);
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return errorResponse({
				status: 405,
				cacheControl: CACHE_CONTROL.noStore,
				message: "Method not allowed",
				extraHeaders: { allow: "GET, HEAD" },
			});
		}

		if (url.pathname === "/healthz") {
			return errorResponse({ status: 200, cacheControl: CACHE_CONTROL.noStore, message: "ok" });
		}

		if (url.pathname === "/") {
			const response = new Response(indexHtml, {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "public, max-age=60",
					"cache-tag": versionTag(env),
					"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
					"x-content-type-options": "nosniff",
				},
			});
			return request.method === "HEAD" ? withoutBody(response) : response;
		}

		const config = loadConfig(env);

		if (url.pathname.startsWith("/img/")) {
			const img = parseImgPath(url.pathname, config.mode);
			let response: Response;
			switch (img.kind) {
				case "redirect":
					response = redirectResponse(img.location);
					break;
				case "invalid":
					response = errorResponse({
						status: 400,
						cacheControl: CACHE_CONTROL.day,
						message: "Malformed preset, format, DID or CID",
					});
					break;
				case "unknown":
					response = errorResponse({
						status: 404,
						cacheControl: CACHE_CONTROL.negative,
						message: "Not found",
					});
					break;
				case "img":
					response = await serveImg(img, env, ctx, config);
					break;
			}
			return request.method === "HEAD" ? withoutBody(response) : response;
		}

		if (config.mode === "scoped") {
			const scoped = parseScopedPath(url.pathname);
			let response: Response;
			switch (scoped.kind) {
				case "redirect":
					response = redirectResponse(scoped.location);
					break;
				case "invalid":
					response = errorResponse({
						status: 400,
						cacheControl: CACHE_CONTROL.day,
						message: "Malformed record reference or CID",
					});
					break;
				case "unknown":
					response = errorResponse({
						status: 404,
						cacheControl: CACHE_CONTROL.negative,
						message: "Not found",
					});
					break;
				case "scoped": {
					const admission = await admit(scoped, env, ctx, config);
					response =
						admission.kind === "deny"
							? admission.response
							: await serveBlob(scoped.did, scoped.cid, env, ctx, config, admission.tags);
					break;
				}
			}
			return request.method === "HEAD" ? withoutBody(response) : response;
		}

		const metadata = url.pathname.startsWith("/metadata/");
		const path = parseBlobPath(metadata ? url.pathname.slice("/metadata".length) : url.pathname);
		let response: Response;
		switch (path.kind) {
			case "redirect":
				response = redirectResponse((metadata ? "/metadata" : "") + path.location);
				break;
			case "invalid":
				response = errorResponse({
					status: 400,
					cacheControl: CACHE_CONTROL.day,
					message: "Malformed DID or CID",
				});
				break;
			case "unknown":
				response = errorResponse({
					status: 404,
					cacheControl: CACHE_CONTROL.negative,
					message: "Not found",
				});
				break;
			case "blob":
				response = metadata
					? await serveMetadata(path.did, path.cid, env, ctx, config)
					: await serveBlob(path.did, path.cid, env, ctx, config);
				break;
		}
		return request.method === "HEAD" ? withoutBody(response) : response;
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		const results = await drain(env, ctx);
		const jetstream = await drainJetstream(env, ctx);
		console.log(JSON.stringify({ event: "drain", results, jetstream }));
	},
} satisfies ExportedHandler<Env>;
