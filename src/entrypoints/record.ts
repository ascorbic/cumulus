import { WorkerEntrypoint } from "cloudflare:workers";
import { loadConfig } from "../config.ts";
import { blobRefs } from "../labels.ts";
import { isValidDid } from "../path.ts";
import {
	CACHE_CONTROL,
	didTag,
	errorResponse,
	jsonResponse,
	purgeEverything,
	purgeTags,
	recordTag,
	versionTag,
} from "../response.ts";

export const RECORD_CACHE_CONTROL = "public, max-age=3600";

const COLLECTION = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/i;
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

export interface RecordInfo {
	uri: string;
	cid: string;
	blobs: string[];
}

export function isValidCollection(value: string): boolean {
	return COLLECTION.test(value);
}

export function isValidRkey(value: string): boolean {
	return RKEY.test(value);
}

/**
 * `GET /record/{did}/{collection}/{rkey}` → `{ uri, cid, blobs }`, read
 * straight from the PDS so a just-written record admits immediately. The
 * TTL is a fallback; deletes and updates arrive as `rec:` tag purges from
 * the Jetstream drain.
 */
export class Record extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const match = /^\/record\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
		if (
			!match ||
			!isValidDid(match[1]!) ||
			!isValidCollection(match[2]!) ||
			!isValidRkey(match[3]!)
		) {
			return errorResponse({
				status: 400,
				cacheControl: CACHE_CONTROL.day,
				message: "Malformed record reference",
			});
		}
		const [, did, collection, rkey] = match as unknown as [string, string, string, string];
		const tags = [didTag(did), recordTag(did, collection, rkey), versionTag(this.env)];
		const identity = await this.ctx.exports.Identity.fetch(`http://identity/did/${did}`);
		if (identity.status === 404) {
			return errorResponse({
				status: 404,
				cacheControl: CACHE_CONTROL.negative,
				tags,
				message: "DID not found or has no PDS",
			});
		}
		if (!identity.ok) {
			return errorResponse({
				status: 502,
				cacheControl: CACHE_CONTROL.noStore,
				message: `Identity returned ${identity.status}: ${await identity.text()}`,
			});
		}
		const { pds } = (await identity.json()) as { pds: string };
		const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
		url.searchParams.set("repo", did);
		url.searchParams.set("collection", collection);
		url.searchParams.set("rkey", rkey);
		let response: Response;
		try {
			response = await fetch(url.href, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(loadConfig(this.env).blobFetchTimeoutMs),
			});
		} catch (error) {
			return errorResponse({
				status: 502,
				cacheControl: CACHE_CONTROL.noStore,
				message: `getRecord failed: ${String(error)}`,
			});
		}
		if (response.status === 400 || response.status === 404) {
			await response.body?.cancel();
			return errorResponse({
				status: 404,
				cacheControl: CACHE_CONTROL.negative,
				tags,
				message: "Record not found",
			});
		}
		if (!response.ok) {
			await response.body?.cancel();
			return errorResponse({
				status: 502,
				cacheControl: CACHE_CONTROL.noStore,
				message: `getRecord returned ${response.status}`,
			});
		}
		const body = (await response.json()) as { uri?: unknown; cid?: unknown; value?: unknown };
		const info: RecordInfo = {
			uri: typeof body.uri === "string" ? body.uri : `at://${did}/${collection}/${rkey}`,
			cid: typeof body.cid === "string" ? body.cid : "",
			blobs: [...blobRefs(body.value)].map((cid) => cid.toLowerCase()),
		};
		return jsonResponse(info, { cacheControl: RECORD_CACHE_CONTROL, tags });
	}

	purgeTags(tags: string[]): Promise<CachePurgeResult> {
		return purgeTags(this.ctx, tags);
	}

	purgeEverything(): Promise<CachePurgeResult> {
		return purgeEverything(this.ctx);
	}
}
