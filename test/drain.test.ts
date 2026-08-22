import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drain } from "../src/drain.ts";
import { keys } from "../src/store.ts";
import { errorFrame, infoFrame, labelsFrame } from "./cbor-encode.ts";
import { DID, PDS, didDocument, stubFetch, type FetchStub } from "./helpers.ts";

const LABELER = "did:plc:ar7c4by46qjdydhdevvrndac";
const MOD_HOST = "mod.example";
const PDS_HOST = new URL(PDS).hostname;
const POST_URI = `at://${DID}/app.bsky.feed.post/3k2abc`;

function labelerDoc(): unknown {
	return {
		id: LABELER,
		service: [
			{ id: "#atproto_labeler", type: "AtprotoLabeler", serviceEndpoint: `https://${MOD_HOST}` },
		],
	};
}

/** A subscribeLabels server that sends the given frames then goes quiet. */
function stream(frames: Uint8Array[], seen: URL[] = []): FetchStub {
	return (url) => {
		seen.push(url);
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		server.accept();
		for (const frame of frames) server.send(frame);
		return new Response(null, { status: 101, webSocket: client });
	};
}

function withEnv(overrides: Record<string, string>): () => void {
	const mutable = env as unknown as Record<string, string>;
	const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, mutable[key]]));
	Object.assign(mutable, overrides);
	return () => Object.assign(mutable, previous);
}

const FAST = { budgetMs: 2000, idleMs: 100 };

describe("drain", () => {
	let restore: () => void;
	let purges: string[][];
	const purge = async (tags: string[]) => {
		purges.push(tags);
		return true;
	};

	beforeEach(async () => {
		purges = [];
		restore = withEnv({ LABELERS: JSON.stringify([{ did: LABELER, vals: ["!takedown"] }]) });
		for (const key of (await env.LABELS_KV.list()).keys) await env.LABELS_KV.delete(key.name);
	});
	afterEach(() => {
		restore();
		vi.restoreAllMocks();
	});

	it("turns account labels into purges and persists the cursor", async () => {
		const seen: URL[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": (url) =>
					Response.json(url.pathname.endsWith(LABELER) ? labelerDoc() : didDocument()),
				[MOD_HOST]: stream(
					[
						infoFrame("OutdatedCursor"),
						labelsFrame(41, [
							{ src: LABELER, uri: DID, val: "!takedown", cts: "2026-08-22T00:00:00Z" },
						]),
						labelsFrame(42, [
							{ src: LABELER, uri: "did:plc:other", val: "porn", cts: "2026-08-22T00:00:00Z" },
						]),
						labelsFrame(43, [
							{ src: "did:plc:someoneelse", uri: "did:plc:x", val: "!takedown", cts: "x" },
						]),
					],
					seen,
				),
			}),
		);
		const results = await drain(env, createExecutionContext(), { ...FAST, purge });
		expect(results).toHaveLength(1);
		expect(results[0]!.status).toMatchObject({ seq: 43, events: 1, purged: 1 });
		expect(seen[0]!.pathname).toBe("/xrpc/com.atproto.label.subscribeLabels");
		expect(seen[0]!.searchParams.has("cursor")).toBe(false);
		expect(purges).toEqual([[`did:${DID}`]]);
		expect(await env.LABELS_KV.get(keys.cursor(LABELER))).toBe("43");
		const status = await env.LABELS_KV.get(keys.status(LABELER), "json");
		expect(status).toMatchObject({ seq: 43, events: 1 });
	});

	it("resumes from the stored cursor", async () => {
		await env.LABELS_KV.put(keys.cursor(LABELER), "43");
		const seen: URL[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(labelerDoc()),
				[MOD_HOST]: stream([], seen),
			}),
		);
		const results = await drain(env, createExecutionContext(), { ...FAST, purge });
		expect(seen[0]!.searchParams.get("cursor")).toBe("43");
		expect(results[0]!.status).toMatchObject({ seq: 43, events: 0, purged: 0 });
		expect(purges).toEqual([]);
	});

	it("enriches record labels into the deny set and clears them on negation", async () => {
		const record = {
			uri: POST_URI,
			value: {
				embed: { images: [{ image: { $type: "blob", ref: { $link: "bafkreiaaa" } } }] },
			},
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": (url) =>
					Response.json(url.pathname.endsWith(LABELER) ? labelerDoc() : didDocument()),
				[PDS_HOST]: (url) => {
					expect(url.pathname).toBe("/xrpc/com.atproto.repo.getRecord");
					expect(url.searchParams.get("rkey")).toBe("3k2abc");
					return Response.json(record);
				},
				[MOD_HOST]: stream([
					labelsFrame(7, [
						{ src: LABELER, uri: POST_URI, val: "!takedown", cts: "2026-08-22T00:00:00Z" },
					]),
				]),
			}),
		);
		await drain(env, createExecutionContext(), { ...FAST, purge });
		expect(await env.LABELS_KV.get(keys.deny(DID, "bafkreiaaa"), "json")).toMatchObject({
			uri: POST_URI,
			val: "!takedown",
		});
		expect(purges).toEqual([[`did:${DID}`, "cid:bafkreiaaa"]]);

		purges = [];
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(labelerDoc()),
				[MOD_HOST]: stream([
					labelsFrame(8, [
						{
							src: LABELER,
							uri: POST_URI,
							val: "!takedown",
							neg: true,
							cts: "2026-08-22T00:00:01Z",
						},
					]),
				]),
			}),
		);
		await drain(env, createExecutionContext(), { ...FAST, purge });
		expect(await env.LABELS_KV.get(keys.deny(DID, "bafkreiaaa"))).toBeNull();
		expect(await env.LABELS_KV.get(keys.record(POST_URI))).toBeNull();
		expect(purges).toEqual([[`did:${DID}`, "cid:bafkreiaaa"]]);
		expect(await env.LABELS_KV.get(keys.cursor(LABELER))).toBe("8");
	});

	it("falls back to the label's cid when the record is gone", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": (url) =>
					Response.json(url.pathname.endsWith(LABELER) ? labelerDoc() : didDocument()),
				[PDS_HOST]: () => Response.json({ error: "RecordNotFound" }, { status: 400 }),
				[MOD_HOST]: stream([
					labelsFrame(9, [
						{
							src: LABELER,
							uri: POST_URI,
							cid: "bafkreiccc",
							val: "!takedown",
							cts: "2026-08-22T00:00:00Z",
						},
					]),
				]),
			}),
		);
		await drain(env, createExecutionContext(), { ...FAST, purge });
		expect(await env.LABELS_KV.get(keys.deny(DID, "bafkreiccc"))).not.toBeNull();
	});

	it("records stream errors in the status without losing the cursor", async () => {
		await env.LABELS_KV.put(keys.cursor(LABELER), "5");
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(labelerDoc()),
				[MOD_HOST]: stream([errorFrame("FutureCursor")]),
			}),
		);
		const results = await drain(env, createExecutionContext(), { ...FAST, purge });
		expect(results[0]!.status.error).toMatch(/FutureCursor/);
		expect(await env.LABELS_KV.get(keys.cursor(LABELER))).toBe("5");
	});
});
