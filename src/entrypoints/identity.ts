import { WorkerEntrypoint } from "cloudflare:workers";
import { loadConfig } from "../config.ts";
import { IdentityError, resolveService, type ServiceKind } from "../identity.ts";
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

const ROUTES: Record<string, { kind: ServiceKind; field: string }> = {
	did: { kind: "pds", field: "pds" },
	labeler: { kind: "labeler", field: "endpoint" },
};

/**
 * `GET /did/{did}` → `{ pds }` and `GET /labeler/{did}` → `{ endpoint }`.
 * Cached per entrypoint, so every caller shares one resolution per DID per
 * TTL.
 */
export class Identity extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const match = /^\/(did|labeler)\/([^/]+)$/.exec(new URL(request.url).pathname);
		const route = match ? ROUTES[match[1]!] : undefined;
		const did = match?.[2];
		if (!route || did === undefined || !isValidDid(did)) {
			return errorResponse({
				status: 400,
				cacheControl: CACHE_CONTROL.day,
				message: "Malformed DID",
			});
		}
		const config = loadConfig(this.env);
		const tags = [didTag(did), versionTag(this.env)];
		let endpoint: string | undefined;
		try {
			endpoint = await resolveService(did, route.kind, {
				plcUrl: config.plcUrl,
				timeoutMs: config.blobFetchTimeoutMs,
			});
		} catch (error) {
			if (!(error instanceof IdentityError)) throw error;
			return errorResponse({
				status: 502,
				cacheControl: CACHE_CONTROL.noStore,
				message: error.message,
			});
		}
		if (endpoint === undefined) {
			return errorResponse({
				status: 404,
				cacheControl: CACHE_CONTROL.negative,
				tags,
				message: `DID not found or has no ${route.kind} service`,
			});
		}
		return jsonResponse(
			{ [route.field]: endpoint },
			{ cacheControl: IDENTITY_CACHE_CONTROL, tags },
		);
	}

	purgeTags(tags: string[]): Promise<CachePurgeResult> {
		return purgeTags(this.ctx, tags);
	}

	purgeEverything(): Promise<CachePurgeResult> {
		return purgeEverything(this.ctx);
	}
}
