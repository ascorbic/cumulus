import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DID, cidFor, didDocument, pngBytes, stubFetch, PDS } from "./helpers.ts";

const ORIGIN = "https://cumulus.example";
const PDS_HOST = new URL(PDS).hostname;

function withLimits(ip: boolean, did: boolean): () => void {
	const mutable = env as unknown as { MISS_LIMIT_IP: RateLimit; MISS_LIMIT_DID: RateLimit };
	const previous = { ip: mutable.MISS_LIMIT_IP, did: mutable.MISS_LIMIT_DID };
	mutable.MISS_LIMIT_IP = { limit: async () => ({ success: ip }) };
	mutable.MISS_LIMIT_DID = { limit: async () => ({ success: did }) };
	return () => {
		mutable.MISS_LIMIT_IP = previous.ip;
		mutable.MISS_LIMIT_DID = previous.did;
	};
}

describe("miss rate limits", () => {
	const image = pngBytes(64);
	let restore: () => void;
	afterEach(() => {
		restore?.();
		vi.restoreAllMocks();
	});

	it("returns an uncacheable 429 when a limit is exceeded", async () => {
		restore = withLimits(true, false);
		vi.spyOn(globalThis, "fetch").mockImplementation(stubFetch({}));
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}/${DID}/${await cidFor(image)}`, {
				headers: { "cf-connecting-ip": "203.0.113.9" },
			}),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("retry-after")).toBe("60");
	});

	it("counts loopbacks against the eyeball request only", async () => {
		const keys: string[] = [];
		const mutable = env as unknown as { MISS_LIMIT_IP: RateLimit; MISS_LIMIT_DID: RateLimit };
		restore = withLimits(true, true);
		mutable.MISS_LIMIT_DID = {
			limit: async ({ key }) => {
				keys.push(key);
				return { success: true };
			},
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(didDocument()),
				[PDS_HOST]: () => new Response(image),
			}),
		);
		const cid = await cidFor(image);
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}/metadata/${DID}/${cid}`, {
				headers: { "cf-connecting-ip": "203.0.113.9" },
			}),
		);
		expect(response.status).toBe(200);
		expect(keys).toEqual([`203.0.113.9 ${DID}`]);
	});

	it("skips requests without a client IP", async () => {
		restore = withLimits(false, false);
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(didDocument()),
				[PDS_HOST]: () => new Response(image),
			}),
		);
		const response = await exports.default.fetch(`${ORIGIN}/${DID}/${await cidFor(image)}`);
		expect(response.status).toBe(200);
	});
});
