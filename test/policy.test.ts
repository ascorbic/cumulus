import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "../src/store.ts";
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

const LABELER = "did:plc:ar7c4by46qjdydhdevvrndac";
const MOD_HOST = "mod.example";

function labelerDoc(): unknown {
	return {
		id: LABELER,
		service: [
			{ id: "#atproto_labeler", type: "AtprotoLabeler", serviceEndpoint: `https://${MOD_HOST}` },
		],
	};
}

function withLabeler(labels: FetchStub): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		stubFetch({ "plc.directory": () => Response.json(labelerDoc()), [MOD_HOST]: labels }),
	);
}

describe("Policy with labelers", () => {
	let restore: () => void;
	afterEach(async () => {
		restore?.();
		vi.restoreAllMocks();
		await env.LABELS_KV.delete(keys.deny(DID, CID));
	});

	it("denies on an enforced account label", async () => {
		restore = withEnv({ LABELERS: JSON.stringify([{ did: LABELER, vals: ["!takedown"] }]) });
		withLabeler((url) => {
			expect(url.pathname).toBe("/xrpc/com.atproto.label.queryLabels");
			expect(url.searchParams.get("uriPatterns")).toBe(DID);
			expect(url.searchParams.get("sources")).toBe(LABELER);
			return Response.json({
				labels: [{ src: LABELER, uri: DID, val: "!takedown", cts: "2026-08-22T00:00:00Z" }],
			});
		});
		const response = await check();
		expect(await response.json()).toEqual({ allow: false, reason: `${LABELER} !takedown` });
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
	});

	it("allows when only non-enforced or negated labels exist", async () => {
		restore = withEnv({ LABELERS: JSON.stringify([{ did: LABELER, vals: ["!takedown"] }]) });
		withLabeler(() =>
			Response.json({
				labels: [
					{ src: LABELER, uri: DID, val: "porn", cts: "2026-08-22T00:00:00Z" },
					{ src: LABELER, uri: DID, val: "!takedown", neg: true, cts: "2026-08-22T00:00:00Z" },
				],
			}),
		);
		const response = await check();
		expect(await response.json()).toEqual({ allow: true });
		expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
	});

	it("fails open by default on a labeler outage", async () => {
		restore = withEnv({ LABELERS: JSON.stringify([{ did: LABELER, vals: ["!takedown"] }]) });
		withLabeler(() => new Response("down", { status: 503 }));
		const response = await check();
		expect(await response.json()).toEqual({ allow: true, degraded: true });
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("fails closed when LABELER_FAIL_OPEN=false", async () => {
		restore = withEnv({
			LABELERS: JSON.stringify([{ did: LABELER, vals: ["!takedown"] }]),
			LABELER_FAIL_OPEN: "false",
		});
		withLabeler(() => new Response("down", { status: 503 }));
		const response = await check();
		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("denies from the record-level deny set before consulting anything", async () => {
		restore = withEnv({ LABELERS: JSON.stringify([{ did: LABELER, vals: ["!takedown"] }]) });
		await env.LABELS_KV.put(
			keys.deny(DID, CID),
			JSON.stringify({
				uri: `at://${DID}/app.bsky.feed.post/3k`,
				src: LABELER,
				val: "!takedown",
				cts: "x",
			}),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(stubFetch({}));
		const response = await check();
		expect(await response.json()).toEqual({
			allow: false,
			reason: `${LABELER} !takedown at://${DID}/app.bsky.feed.post/3k`,
		});
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
	});
});
