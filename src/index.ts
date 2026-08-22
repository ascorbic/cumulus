import { handleAdmin } from "./admin.ts";
import { fetchBlob, sha256 } from "./blob.ts";
import { decodeBlobCid, digestsEqual } from "./cid.ts";
import { loadConfig, type Config } from "./config.ts";
import { parseBlobPath } from "./path.ts";
import {
	CACHE_CONTROL,
	blobResponse,
	blobTags,
	didTag,
	errorResponse,
	redirectResponse,
	versionTag,
} from "./response.ts";
import { sniff } from "./sniff.ts";

export { Identity } from "./entrypoints/identity.ts";
export { Policy } from "./entrypoints/policy.ts";

type Resolution =
	| { kind: "pds"; pds: string }
	| { kind: "not-found" }
	| { kind: "error"; detail: string };

async function resolveIdentity(ctx: ExecutionContext, did: string): Promise<Resolution> {
	const response = await ctx.exports.Identity.fetch(`http://identity/did/${did}`);
	if (response.status === 404) return { kind: "not-found" };
	if (!response.ok)
		return {
			kind: "error",
			detail: `Identity returned ${response.status}: ${await response.text()}`,
		};
	const { pds } = (await response.json()) as { pds: string };
	return { kind: "pds", pds };
}

type PolicyResult =
	| { kind: "allow" }
	| { kind: "deny"; reason?: string }
	| { kind: "error"; detail: string };

async function checkPolicy(ctx: ExecutionContext, did: string, cid: string): Promise<PolicyResult> {
	const response = await ctx.exports.Policy.fetch(`http://policy/check/${did}/${cid}`);
	if (!response.ok)
		return {
			kind: "error",
			detail: `Policy returned ${response.status}: ${await response.text()}`,
		};
	const verdict = (await response.json()) as { allow: boolean; reason?: string };
	return verdict.allow ? { kind: "allow" } : { kind: "deny", reason: verdict.reason };
}

async function serveBlob(
	did: string,
	cid: string,
	env: Env,
	ctx: ExecutionContext,
	config: Config,
): Promise<Response> {
	let expectedDigest: Uint8Array;
	try {
		expectedDigest = decodeBlobCid(cid);
	} catch (error) {
		return errorResponse({
			status: 400,
			cacheControl: CACHE_CONTROL.day,
			message: `Unsupported CID: ${(error as Error).message}`,
		});
	}
	const version = versionTag(env);
	const tags = [...blobTags(did, cid), version];

	const identity = await resolveIdentity(ctx, did);
	if (identity.kind === "error") {
		return errorResponse({
			status: 502,
			cacheControl: CACHE_CONTROL.noStore,
			message: identity.detail,
		});
	}
	if (identity.kind === "not-found") {
		return errorResponse({
			status: 404,
			cacheControl: CACHE_CONTROL.negative,
			tags: [didTag(did), version],
			message: "DID not found or has no PDS",
		});
	}

	const policy = await checkPolicy(ctx, did, cid);
	if (policy.kind === "error") {
		return errorResponse({
			status: 502,
			cacheControl: CACHE_CONTROL.noStore,
			message: policy.detail,
		});
	}
	if (policy.kind === "deny") {
		return errorResponse({
			status: 403,
			cacheControl: CACHE_CONTROL.day,
			tags,
			message: "Forbidden",
		});
	}

	const blob = await fetchBlob(identity.pds, did, cid, {
		maxSize: config.blobMaxSize,
		timeoutMs: config.blobFetchTimeoutMs,
	});
	switch (blob.status) {
		case "not-found":
			return errorResponse({
				status: 404,
				cacheControl: CACHE_CONTROL.negative,
				tags,
				message: "Blob not found",
			});
		case "too-large":
			return errorResponse({
				status: 413,
				cacheControl: CACHE_CONTROL.day,
				tags,
				message: "Blob exceeds size limit",
			});
		case "upstream-error":
			return errorResponse({
				status: 502,
				cacheControl: CACHE_CONTROL.noStore,
				message: blob.detail,
			});
	}

	if (!digestsEqual(await sha256(blob.bytes), expectedDigest)) {
		console.error(
			JSON.stringify({
				event: "cid-mismatch",
				did,
				cid,
				pds: identity.pds,
				bytes: blob.bytes.byteLength,
			}),
		);
		return errorResponse({
			status: 502,
			cacheControl: CACHE_CONTROL.noStore,
			message: "Blob failed CID verification",
		});
	}

	const type = sniff(blob.bytes);
	if (!config.allowedMimeTypes.has(type.mime)) {
		return errorResponse({
			status: 415,
			cacheControl: CACHE_CONTROL.day,
			tags,
			message: `Content type ${type.mime} is not allowed`,
		});
	}
	return blobResponse(blob.bytes, { cid, ...type, tags }, config);
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

		const path = parseBlobPath(url.pathname);
		let response: Response;
		switch (path.kind) {
			case "redirect":
				response = redirectResponse(path.location);
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
				response = await serveBlob(path.did, path.cid, env, ctx, loadConfig(env));
				break;
		}
		return request.method === "HEAD" ? withoutBody(response) : response;
	},
} satisfies ExportedHandler<Env>;
