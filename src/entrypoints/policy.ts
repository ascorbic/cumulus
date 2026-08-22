import { WorkerEntrypoint } from "cloudflare:workers";
import { CID_PATTERN } from "../cid.ts";
import { isValidDid } from "../path.ts";
import {
	CACHE_CONTROL,
	blobTags,
	errorResponse,
	jsonResponse,
	purgeEverything,
	purgeTags,
	versionTag,
} from "../response.ts";

export const POLICY_CACHE_CONTROL = {
	allow: "public, max-age=3600",
	deny: "public, max-age=86400",
	failure: CACHE_CONTROL.noStore,
} as const;

export interface Verdict {
	allow: boolean;
	reason?: string;
}

/**
 * `GET /check/{did}/{cid}` → `{ allow, reason? }`. Verdict sources (external
 * policy service, labelers, record-level deny set) arrive in phases 4 and 5;
 * until then every request is allowed. The response shape, TTLs and tags are
 * the contract those phases fill in.
 */
export class Policy extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const match = /^\/check\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
		if (!match || !isValidDid(match[1]!) || !CID_PATTERN.test(match[2]!)) {
			return errorResponse({
				status: 400,
				cacheControl: CACHE_CONTROL.day,
				message: "Malformed DID or CID",
			});
		}
		const [, did, cid] = match as unknown as [string, string, string];
		const tags = [...blobTags(did, cid), versionTag(this.env)];
		const verdict = await this.check(did, cid);
		return jsonResponse(verdict, {
			cacheControl: verdict.allow ? POLICY_CACHE_CONTROL.allow : POLICY_CACHE_CONTROL.deny,
			tags,
		});
	}

	protected check(_did: string, _cid: string): Promise<Verdict> {
		return Promise.resolve({ allow: true });
	}

	purgeTags(tags: string[]): Promise<CachePurgeResult> {
		return purgeTags(this.ctx, tags);
	}

	purgeEverything(): Promise<CachePurgeResult> {
		return purgeEverything(this.ctx);
	}
}
