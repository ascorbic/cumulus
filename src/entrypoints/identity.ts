import { WorkerEntrypoint } from "cloudflare:workers";
import { loadConfig } from "../config.ts";
import { IdentityError, resolvePds } from "../identity.ts";
import { isValidDid } from "../path.ts";
import {
	CACHE_CONTROL,
	didTag,
	errorResponse,
	jsonResponse,
	purgeEverything,
	purgeTags,
	versionTag,
} from "../response.ts";

export const IDENTITY_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

/**
 * `GET /did/{did}` → `{ pds }`. Cached per entrypoint, so every caller shares
 * one resolution per DID per TTL.
 */
export class Identity extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const did = new URL(request.url).pathname.replace(/^\/did\//, "");
		if (!isValidDid(did)) {
			return errorResponse({
				status: 400,
				cacheControl: CACHE_CONTROL.day,
				message: "Malformed DID",
			});
		}
		const config = loadConfig(this.env);
		const tags = [didTag(did), versionTag(this.env)];
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
				tags,
				message: "DID not found or has no PDS",
			});
		}
		return jsonResponse({ pds }, { cacheControl: IDENTITY_CACHE_CONTROL, tags });
	}

	purgeTags(tags: string[]): Promise<CachePurgeResult> {
		return purgeTags(this.ctx, tags);
	}

	purgeEverything(): Promise<CachePurgeResult> {
		return purgeEverything(this.ctx);
	}
}
