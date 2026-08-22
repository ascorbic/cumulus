import { CID_PATTERN } from "./cid.ts";
import { configHash, loadConfig } from "./config.ts";
import { drain } from "./drain.ts";
import { readCursor, readStatus } from "./store.ts";
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

const OK: CachePurgeResult = { success: true, errors: [] };

function notFound(): Response {
	return errorResponse({ status: 404, cacheControl: CACHE_CONTROL.noStore, message: "Not found" });
}

function badRequest(message: string): Response {
	return errorResponse({ status: 400, cacheControl: CACHE_CONTROL.noStore, message });
}

function methodNotAllowed(allow: string): Response {
	return errorResponse({
		status: 405,
		cacheControl: CACHE_CONTROL.noStore,
		message: "Method not allowed",
		extraHeaders: { allow },
	});
}

function purgeResponse(results: PurgeResults): Response {
	const success = Object.values(results).every((result) => result.success);
	return jsonResponse(
		{ success, results },
		{ status: success ? 200 : 502, cacheControl: CACHE_CONTROL.noStore },
	);
}

/**
 * Purges are scoped to the entrypoint that issues them, so each one fans out
 * through the other entrypoints' `purgeTags` RPC methods. The fan-out is
 * sequential and not transactional; every verdict has a finite TTL, so a
 * partial purge self-heals.
 */
async function handlePurge(
	ctx: ExecutionContext,
	kind: string | undefined,
	id: string | undefined,
): Promise<Response> {
	switch (kind) {
		case "actor": {
			if (id === undefined || !isValidDid(id)) return badRequest("Malformed DID");
			const tags = [didTag(id)];
			return purgeResponse({
				default: await purgeTags(ctx, tags),
				Policy: await ctx.exports.Policy.purgeTags(tags),
				Identity: await ctx.exports.Identity.purgeTags(tags),
			});
		}
		case "blob": {
			if (id === undefined || !CID_PATTERN.test(id)) return badRequest("Malformed CID");
			const tags = [cidTag(id)];
			return purgeResponse({
				default: await purgeTags(ctx, tags),
				Policy: await ctx.exports.Policy.purgeTags(tags),
				Identity: OK,
			});
		}
		case "version": {
			if (id === undefined || !/^[0-9a-f-]{36}$/.test(id))
				return badRequest("Malformed version id");
			const tags = [`v:${id}`];
			return purgeResponse({
				default: await purgeTags(ctx, tags),
				Policy: await ctx.exports.Policy.purgeTags(tags),
				Identity: await ctx.exports.Identity.purgeTags(tags),
			});
		}
		case "config": {
			if (id === undefined || !/^[0-9a-f]{16}$/.test(id))
				return badRequest("Malformed config hash");
			return purgeResponse({
				default: await purgeTags(ctx, [`cfg:${id}`]),
				Policy: OK,
				Identity: OK,
			});
		}
		case "all": {
			if (id !== undefined) return notFound();
			return purgeResponse({
				default: await purgeEverything(ctx),
				Policy: await ctx.exports.Policy.purgeEverything(),
				Identity: await ctx.exports.Identity.purgeEverything(),
			});
		}
		default:
			return notFound();
	}
}

async function handleConfig(env: Env): Promise<Response> {
	const config = loadConfig(env);
	return jsonResponse(
		{
			hash: await configHash(env),
			config: { ...config, allowedMimeTypes: [...config.allowedMimeTypes] },
		},
		{ cacheControl: CACHE_CONTROL.noStore },
	);
}

async function handleLabelsStatus(env: Env): Promise<Response> {
	const labelers = await Promise.all(
		loadConfig(env).labelers.map(async (labeler) => ({
			did: labeler.did,
			vals: labeler.vals,
			cursor: await readCursor(env.LABELS_KV, labeler.did),
			status: await readStatus(env.LABELS_KV, labeler.did),
		})),
	);
	return jsonResponse({ labelers }, { cacheControl: CACHE_CONTROL.noStore });
}

async function handleLabelsDrain(env: Env, ctx: ExecutionContext): Promise<Response> {
	return jsonResponse({ results: await drain(env, ctx) }, { cacheControl: CACHE_CONTROL.noStore });
}

/** `/admin/*`: Basic auth against `ADMIN_PASSWORD`; absent password → 404. */
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
	const [, area, kind, id, ...rest] = new URL(request.url).pathname.split("/").filter(Boolean);
	if (rest.length > 0) return notFound();
	switch (area) {
		case "purge":
			if (request.method !== "POST") return methodNotAllowed("POST");
			return handlePurge(ctx, kind, id);
		case "config":
			if (kind !== undefined) return notFound();
			if (request.method !== "GET") return methodNotAllowed("GET");
			return handleConfig(env);
		case "labels":
			if (id !== undefined) return notFound();
			if (kind === "status") {
				if (request.method !== "GET") return methodNotAllowed("GET");
				return handleLabelsStatus(env);
			}
			if (kind === "drain") {
				if (request.method !== "POST") return methodNotAllowed("POST");
				return handleLabelsDrain(env, ctx);
			}
			return notFound();
		default:
			return notFound();
	}
}
