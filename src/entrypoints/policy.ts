import { WorkerEntrypoint } from "cloudflare:workers";
import { CID_PATTERN } from "../cid.ts";
import { loadConfig, type Config } from "../config.ts";
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

export const POLICY_TIMEOUT_MS = 5000;

export interface Verdict {
	allow: boolean;
	reason?: string;
	/** True when a source was unreachable and the verdict is a fail-open default. */
	degraded?: boolean;
}

export class PolicyOutage extends Error {}

/**
 * External policy service contract: `GET {POLICY_URL}/{did}/{cid}` → 200
 * allow, 403 deny (body, if any, is the reason), anything else is an outage.
 */
async function queryPolicyService(url: string, did: string, cid: string): Promise<Verdict> {
	let response: Response;
	try {
		response = await fetch(`${url}/${did}/${cid}`, {
			headers: { accept: "text/plain, application/json" },
			signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
		});
	} catch (error) {
		throw new PolicyOutage(`Policy service unreachable: ${String(error)}`);
	}
	if (response.status === 200) {
		await response.body?.cancel();
		return { allow: true };
	}
	if (response.status === 403) {
		const reason = (await response.text()).trim().slice(0, 200);
		return reason ? { allow: false, reason } : { allow: false };
	}
	await response.body?.cancel();
	throw new PolicyOutage(`Policy service returned ${response.status}`);
}

/**
 * `GET /check/{did}/{cid}` → `{ allow, reason?, degraded? }`. Allow verdicts
 * cache for an hour, denies for a day, and a fail-open verdict during an
 * outage is never cached.
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
		const config = loadConfig(this.env);
		let verdict: Verdict;
		try {
			verdict = await this.check(did, cid, config);
		} catch (error) {
			if (!(error instanceof PolicyOutage)) throw error;
			console.error(JSON.stringify({ event: "policy-outage", did, cid, detail: error.message }));
			if (!config.policyFailOpen) {
				return errorResponse({
					status: 502,
					cacheControl: POLICY_CACHE_CONTROL.failure,
					message: error.message,
				});
			}
			return jsonResponse(
				{ allow: true, degraded: true },
				{ cacheControl: POLICY_CACHE_CONTROL.failure, tags },
			);
		}
		return jsonResponse(verdict, {
			cacheControl: verdict.allow ? POLICY_CACHE_CONTROL.allow : POLICY_CACHE_CONTROL.deny,
			tags,
		});
	}

	protected async check(did: string, cid: string, config: Config): Promise<Verdict> {
		if (config.policyUrl) {
			const verdict = await queryPolicyService(config.policyUrl, did, cid);
			if (!verdict.allow) return verdict;
		}
		return { allow: true };
	}

	purgeTags(tags: string[]): Promise<CachePurgeResult> {
		return purgeTags(this.ctx, tags);
	}

	purgeEverything(): Promise<CachePurgeResult> {
		return purgeEverything(this.ctx);
	}
}
