import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JETSTREAM, drainJetstream, jetstreamUrl } from "../src/jetstream.ts";
import { keys } from "../src/store.ts";
import { DID, stubFetch, type FetchStub } from "./helpers.ts";

const JETSTREAM_HOST = "jetstream.example";

function withEnv(overrides: Record<string, string>): () => void {
	const mutable = env as unknown as Record<string, string>;
	const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, mutable[key]]));
	Object.assign(mutable, overrides);
	return () => Object.assign(mutable, previous);
}

function stream(events: unknown[], seen: URL[] = []): FetchStub {
	return (url) => {
		seen.push(url);
		const pair = new WebSocketPair();
		pair[1].accept();
		for (const event of events) pair[1].send(JSON.stringify(event));
		return new Response(null, { status: 101, webSocket: pair[0] });
	};
}

const commit = (time_us: number, operation: string, collection: string, rkey: string) => ({
	did: DID,
	time_us,
	kind: "commit",
	commit: { rev: "x", operation, collection, rkey },
});

const FAST = { budgetMs: 2000, idleMs: 100 };

describe("drainJetstream", () => {
	let restore: () => void;
	let purges: string[][];
	const purge = async (tags: string[]) => {
		purges.push(tags);
		return true;
	};

	beforeEach(async () => {
		purges = [];
		restore = withEnv({
			MODE: "scoped",
			SCOPED_COLLECTIONS: "app.example.*",
			JETSTREAM_URL: `wss://${JETSTREAM_HOST}`,
		});
		await env.LABELS_KV.delete(keys.cursor(JETSTREAM));
		await env.LABELS_KV.delete(keys.status(JETSTREAM));
	});
	afterEach(() => {
		restore();
		vi.restoreAllMocks();
	});

	it("builds the subscribe URL with wanted collections and cursor", () => {
		expect(jetstreamUrl("wss://j.example", ["app.example.*", "app.other.post"], null)).toBe(
			"wss://j.example/subscribe?wantedCollections=app.example.*&wantedCollections=app.other.post",
		);
		expect(jetstreamUrl("wss://j.example", ["app.example.post"], 123)).toContain("&cursor=123");
	});

	it("purges rec: tags for deletes and updates, skipping creates", async () => {
		const seen: URL[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				[JETSTREAM_HOST]: stream(
					[
						commit(1001, "create", "app.example.post", "a"),
						commit(1002, "delete", "app.example.post", "b"),
						commit(1003, "update", "app.example.profile", "self"),
						commit(1004, "delete", "app.other.post", "c"),
						{ did: DID, time_us: 1005, kind: "identity" },
					],
					seen,
				),
			}),
		);
		const status = await drainJetstream(env, createExecutionContext(), { ...FAST, purge });
		expect(status).toMatchObject({ seq: 1005, events: 2, purged: 2 });
		expect(seen[0]!.pathname).toBe("/subscribe");
		expect(seen[0]!.searchParams.getAll("wantedCollections")).toEqual(["app.example.*"]);
		expect(purges).toEqual([
			[`rec:${DID}/app.example.post/b`, `rec:${DID}/app.example.profile/self`],
		]);
		expect(await env.LABELS_KV.get(keys.cursor(JETSTREAM))).toBe("1005");
	});

	it("resumes from the stored cursor and is a no-op in open mode", async () => {
		await env.LABELS_KV.put(keys.cursor(JETSTREAM), "999");
		const seen: URL[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({ [JETSTREAM_HOST]: stream([], seen) }),
		);
		await drainJetstream(env, createExecutionContext(), { ...FAST, purge });
		expect(seen[0]!.searchParams.get("cursor")).toBe("999");
		restore();
		restore = withEnv({ MODE: "open" });
		expect(await drainJetstream(env, createExecutionContext(), { ...FAST, purge })).toBeUndefined();
	});
});
