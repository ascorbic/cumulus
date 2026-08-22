import { CACHE_CONTROL, errorResponse } from "./response.ts";

/**
 * Misses are the only requests that run the Worker, so limiting here limits
 * PDS fetches and CPU without touching cached traffic. Loopback requests
 * carry no client IP and are not counted; the eyeball request that caused
 * them already was.
 */
export async function enforceMissLimits(
	request: Request,
	env: Env,
	did: string | undefined,
): Promise<Response | undefined> {
	const ip = request.headers.get("cf-connecting-ip");
	if (!ip) return undefined;
	const checks = [env.MISS_LIMIT_IP.limit({ key: ip })];
	if (did) checks.push(env.MISS_LIMIT_DID.limit({ key: `${ip} ${did.toLowerCase()}` }));
	const outcomes = await Promise.all(checks);
	if (outcomes.every((outcome) => outcome.success)) return undefined;
	return errorResponse({
		status: 429,
		cacheControl: CACHE_CONTROL.noStore,
		message: "Too many uncached requests; try again shortly",
		extraHeaders: { "retry-after": "60" },
	});
}
