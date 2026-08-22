import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DID, stubFetch, type FetchStub } from "./helpers.ts";

const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const POLICY_HOST = "policy.example";

function withEnv(overrides: Record<string, string>): () => void {
	const mutable = env as unknown as Record<string, string>;
	const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, mutable[key]]));
	Object.assign(mutable, overrides);
	return () => Object.assign(mutable, previous);
}

function withService(handler: FetchStub): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(stubFetch({ [POLICY_HOST]: handler }));
}

const check = () => exports.Policy.fetch(`http://policy/check/${DID}/${CID}`);

describe("Policy with POLICY_URL", () => {
	let restore: () => void;
	afterEach(() => {
		restore?.();
		vi.restoreAllMocks();
	});

	it("allows on 200 with a one-hour verdict", async () => {
		restore = withEnv({ POLICY_URL: `https://${POLICY_HOST}/v1/` });
		withService((url) => {
			expect(url.pathname).toBe(`/v1/${DID}/${CID}`);
			return new Response("ok");
		});
		const response = await check();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ allow: true });
		expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
	});

	it("denies on 403 with a one-day verdict and the reason", async () => {
		restore = withEnv({ POLICY_URL: `https://${POLICY_HOST}` });
		withService(() => new Response("takedown", { status: 403 }));
		const response = await check();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ allow: false, reason: "takedown" });
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(response.headers.get("cache-tag")).toContain(`cid:${CID}`);
	});

	it("fails closed by default with an uncacheable 502", async () => {
		restore = withEnv({ POLICY_URL: `https://${POLICY_HOST}` });
		withService(() => new Response("boom", { status: 500 }));
		const response = await check();
		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("fails open when configured, without caching the degraded verdict", async () => {
		restore = withEnv({ POLICY_URL: `https://${POLICY_HOST}`, POLICY_FAIL_OPEN: "true" });
		withService(() => {
			throw new TypeError("connect ECONNREFUSED");
		});
		const response = await check();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ allow: true, degraded: true });
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});
