import { fetchBlob } from "./blob.ts";
import { decodeBlobCid, digestsEqual } from "./cid.ts";
import { loadConfig, type Config } from "./config.ts";
import { IdentityError, resolvePds } from "./identity.ts";
import { parseBlobPath } from "./path.ts";
import {
	CACHE_CONTROL,
	blobResponse,
	blobTags,
	errorResponse,
	redirectResponse,
} from "./response.ts";
import { sniff } from "./sniff.ts";

async function serveBlob(did: string, cid: string, config: Config): Promise<Response> {
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
	const tags = blobTags(did, cid);

	let pds: string | undefined;
	try {
		pds = await resolvePds(did, { plcUrl: config.plcUrl, timeoutMs: config.blobFetchTimeoutMs });
	} catch (error) {
		if (!(error instanceof IdentityError)) throw error;
		return errorResponse({
			status: 502,
			cacheControl: CACHE_CONTROL.noStore,
			message: error.message,
		});
	}
	if (pds === undefined) {
		return errorResponse({
			status: 404,
			cacheControl: CACHE_CONTROL.negative,
			tags: [tags[0]!],
			message: "DID not found or has no PDS",
		});
	}

	const blob = await fetchBlob(pds, did, cid, {
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

	if (!digestsEqual(blob.digest, expectedDigest)) {
		console.error(
			JSON.stringify({ event: "cid-mismatch", did, cid, pds, bytes: blob.bytes.byteLength }),
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
	return blobResponse(blob.bytes, { did, cid, ...type }, config);
}

function withoutBody(response: Response): Response {
	return new Response(null, response);
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const config = loadConfig(env);

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
				response = await serveBlob(path.did, path.cid, config);
				break;
		}
		return request.method === "HEAD" ? withoutBody(response) : response;
	},
} satisfies ExportedHandler<Env>;
