import { CID_PATTERN } from "./cid.ts";
import { isValidDid } from "./path.ts";
import {
	CACHE_CONTROL,
	cidTag,
	didTag,
	errorResponse,
	jsonResponse,
	purgeEverything,
	purgeTags,
} from "./response.ts";

function timingSafeEqualStrings(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.byteLength !== right.byteLength) return false;
	return crypto.subtle.timingSafeEqual(left, right);
}

export function isAuthorised(request: Request, password: string): boolean {
	const header = request.headers.get("authorization") ?? "";
	const [scheme, credentials] = header.split(" ", 2);
	if (scheme?.toLowerCase() !== "basic" || !credentials) return false;
	let decoded: string;
	try {
		decoded = atob(credentials);
	} catch {
		return false;
	}
	const separator = decoded.indexOf(":");
	if (separator === -1) return false;
	return timingSafeEqualStrings(decoded.slice(separator + 1), password);
}

type PurgeResults = Record<"default" | "Policy" | "Identity", CachePurgeResult>;

function notFound(): Response {
	return errorResponse({ status: 404, cacheControl: CACHE_CONTROL.noStore, message: "Not found" });
}

/**
 * `POST /admin/purge/{actor|blob|version}/{id}` and `POST /admin/purge/all`.
 * Purges are scoped to the entrypoint that issues them, so each one fans out
 * through the other entrypoints' `purgeTags` RPC methods. The fan-out is
 * sequential and not transactional; every verdict has a finite TTL, so a
 * partial purge self-heals.
 */
export async function handleAdmin(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!env.ADMIN_PASSWORD) return notFound();
	if (!isAuthorised(request, env.ADMIN_PASSWORD)) {
		return errorResponse({
			status: 401,
			cacheControl: CACHE_CONTROL.noStore,
			message: "Unauthorized",
			extraHeaders: { "www-authenticate": 'Basic realm="cumulus admin"' },
		});
	}
	if (request.method !== "POST") {
		return errorResponse({
			status: 405,
			cacheControl: CACHE_CONTROL.noStore,
			message: "Method not allowed",
			extraHeaders: { allow: "POST" },
		});
	}
	const segments = new URL(request.url).pathname.split("/").filter(Boolean);
	if (segments[0] !== "admin" || segments[1] !== "purge") return notFound();
	const [, , kind, id, ...rest] = segments;
	if (rest.length > 0) return notFound();

	let results: PurgeResults;
	switch (kind) {
		case "actor": {
			if (id === undefined || !isValidDid(id)) return badRequest("Malformed DID");
			const tags = [didTag(id)];
			results = {
				default: await purgeTags(ctx, tags),
				Policy: await ctx.exports.Policy.purgeTags(tags),
				Identity: await ctx.exports.Identity.purgeTags(tags),
			};
			break;
		}
		case "blob": {
			if (id === undefined || !CID_PATTERN.test(id)) return badRequest("Malformed CID");
			const tags = [cidTag(id)];
			results = {
				default: await purgeTags(ctx, tags),
				Policy: await ctx.exports.Policy.purgeTags(tags),
				Identity: { success: true, errors: [] },
			};
			break;
		}
		case "version": {
			if (id === undefined || !/^[0-9a-f-]{36}$/.test(id))
				return badRequest("Malformed version id");
			const tags = [`v:${id}`];
			results = {
				default: await purgeTags(ctx, tags),
				Policy: await ctx.exports.Policy.purgeTags(tags),
				Identity: await ctx.exports.Identity.purgeTags(tags),
			};
			break;
		}
		case "all": {
			if (id !== undefined) return notFound();
			results = {
				default: await purgeEverything(ctx),
				Policy: await ctx.exports.Policy.purgeEverything(),
				Identity: await ctx.exports.Identity.purgeEverything(),
			};
			break;
		}
		default:
			return notFound();
	}
	const success = Object.values(results).every((result) => result.success);
	return jsonResponse(
		{ success, results },
		{ status: success ? 200 : 502, cacheControl: CACHE_CONTROL.noStore },
	);
}

function badRequest(message: string): Response {
	return errorResponse({ status: 400, cacheControl: CACHE_CONTROL.noStore, message });
}
