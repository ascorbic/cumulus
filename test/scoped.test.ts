import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { collectionMatches } from "../src/jetstream.ts";
import { parseScopedPath } from "../src/scoped.ts";
import { DID, PDS, cidFor, didDocument, pngBytes, stubFetch } from "./helpers.ts";

const ORIGIN = "https://cumulus.example";
const PDS_HOST = new URL(PDS).hostname;
const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const COLLECTION = "app.example.post";
const RKEY = "3k2abc";
const version = `v:${env.VERSION.id}`;

function withEnv(overrides: Record<string, string>): () => void {
	const mutable = env as unknown as Record<string, string>;
	const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, mutable[key]]));
	Object.assign(mutable, overrides);
	return () => Object.assign(mutable, previous);
}

const get = (path: string, init?: RequestInit) =>
	exports.default.fetch(new Request(ORIGIN + path, { redirect: "manual", ...init }));

describe("config", () => {
	it("parses mode and collections", () => {
		expect(
			loadConfig({ MODE: "scoped", SCOPED_COLLECTIONS: "app.example.post, app.other.*" }),
		).toMatchObject({
			mode: "scoped",
			scopedCollections: ["app.example.post", "app.other.*"],
		});
		expect(() => loadConfig({ MODE: "scoped" })).toThrow(/SCOPED_COLLECTIONS/);
		expect(() => loadConfig({ MODE: "closed" })).toThrow(/MODE/);
		expect(() => loadConfig({ SCOPED_COLLECTIONS: "not a collection" })).toThrow(/collection/);
	});

	it("matches collections exactly or by prefix", () => {
		expect(collectionMatches("app.example.post", ["app.example.post"])).toBe(true);
		expect(collectionMatches("app.example.posts", ["app.example.post"])).toBe(false);
		expect(collectionMatches("app.example.post", ["app.example.*"])).toBe(true);
		expect(collectionMatches("app.example", ["app.example.*"])).toBe(true);
		expect(collectionMatches("app.examples.post", ["app.example.*"])).toBe(false);
	});
});

describe("parseScopedPath", () => {
	it("parses and canonicalises record-scoped paths", () => {
		expect(parseScopedPath(`/r/${DID}/${COLLECTION}/${RKEY}/${CID}`)).toEqual({
			kind: "scoped",
			did: DID,
			collection: COLLECTION,
			rkey: RKEY,
			cid: CID,
		});
		expect(parseScopedPath(`/r/${DID}/${COLLECTION}/${RKEY}/${CID.toUpperCase()}`)).toEqual({
			kind: "redirect",
			location: `/r/${DID}/${COLLECTION}/${RKEY}/${CID}`,
		});
		expect(parseScopedPath(`/r/${DID}/${COLLECTION}/${RKEY}/${CID}/`)).toEqual({ kind: "unknown" });
		expect(parseScopedPath(`/r/${DID}/not valid/${RKEY}/${CID}`)).toEqual({ kind: "invalid" });
		expect(parseScopedPath(`/r/did:plc:nope/${COLLECTION}/${RKEY}/${CID}`)).toEqual({
			kind: "invalid",
		});
		expect(parseScopedPath(`/${DID}/${CID}`)).toEqual({ kind: "unknown" });
	});
});

describe("scoped mode", () => {
	const image = pngBytes(256);
	let restore: () => void;
	afterEach(() => {
		restore?.();
		vi.restoreAllMocks();
	});

	function stubPds(blobs: string[], recordStatus = 200): void {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(didDocument()),
				[PDS_HOST]: (url) => {
					if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
						expect(url.searchParams.get("collection")).toBe(COLLECTION);
						if (recordStatus !== 200) {
							return Response.json({ error: "RecordNotFound" }, { status: recordStatus });
						}
						return Response.json({
							uri: `at://${DID}/${COLLECTION}/${RKEY}`,
							cid: "bafyreirecord",
							value: {
								images: blobs.map((cid) => ({ $type: "blob", ref: { $link: cid } })),
							},
						});
					}
					return new Response(image);
				},
			}),
		);
	}

	it("serves a blob referenced by the record, tagged with the record", async () => {
		restore = withEnv({ MODE: "scoped", SCOPED_COLLECTIONS: "app.example.*" });
		const cid = await cidFor(image);
		stubPds([cid, "bafkreiother"]);
		const response = await get(`/r/${DID}/${COLLECTION}/${RKEY}/${cid}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("cache-tag")).toBe(
			`did:${DID},cid:${cid},rec:${DID}/${COLLECTION}/${RKEY},${version}`,
		);
	});

	it("denies a blob the record does not reference", async () => {
		restore = withEnv({ MODE: "scoped", SCOPED_COLLECTIONS: COLLECTION });
		stubPds(["bafkreiother"]);
		const response = await get(`/r/${DID}/${COLLECTION}/${RKEY}/${CID}`);
		expect(response.status).toBe(403);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(response.headers.get("cache-tag")).toBe(
			`did:${DID},cid:${CID},rec:${DID}/${COLLECTION}/${RKEY},${version}`,
		);
	});

	it("denies collections outside the allowlist without touching the PDS", async () => {
		restore = withEnv({ MODE: "scoped", SCOPED_COLLECTIONS: "app.other.post" });
		vi.spyOn(globalThis, "fetch").mockImplementation(stubFetch({}));
		const response = await get(`/r/${DID}/${COLLECTION}/${RKEY}/${CID}`);
		expect(response.status).toBe(403);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
	});

	it("returns a short-lived tagged 404 for a missing record", async () => {
		restore = withEnv({ MODE: "scoped", SCOPED_COLLECTIONS: COLLECTION });
		stubPds([], 400);
		const response = await get(`/r/${DID}/${COLLECTION}/${RKEY}/${CID}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get("cache-tag")).toContain(`rec:${DID}/${COLLECTION}/${RKEY}`);
	});

	it("disables the open routes in scoped mode and the scoped routes in open mode", async () => {
		restore = withEnv({ MODE: "scoped", SCOPED_COLLECTIONS: COLLECTION });
		vi.spyOn(globalThis, "fetch").mockImplementation(stubFetch({}));
		expect((await get(`/${DID}/${CID}`)).status).toBe(404);
		expect((await get(`/metadata/${DID}/${CID}`)).status).toBe(404);
		expect((await get(`/img/avatar/plain/${DID}/${CID}`)).status).toBe(404);
		restore();
		restore = withEnv({ MODE: "open" });
		expect((await get(`/r/${DID}/${COLLECTION}/${RKEY}/${CID}`)).status).toBe(404);
		expect((await get(`/img/avatar/r/${DID}/${COLLECTION}/${RKEY}/${CID}`)).status).toBe(404);
	});

	it("redirects non-canonical scoped paths", async () => {
		restore = withEnv({ MODE: "scoped", SCOPED_COLLECTIONS: COLLECTION });
		const response = await get(`/r/${DID}/${COLLECTION}/${RKEY}/${CID.toUpperCase()}`);
		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe(`/r/${DID}/${COLLECTION}/${RKEY}/${CID}`);
	});
});

describe("Record entrypoint", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns the record's blob refs with record tags", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(didDocument()),
				[PDS_HOST]: () =>
					Response.json({
						uri: `at://${DID}/${COLLECTION}/${RKEY}`,
						cid: "bafyreirecord",
						value: { avatar: { $type: "blob", ref: { $link: "BAFKREIAAA" } } },
					}),
			}),
		);
		const response = await exports.Record.fetch(
			`http://record/record/${DID}/${COLLECTION}/${RKEY}`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			uri: `at://${DID}/${COLLECTION}/${RKEY}`,
			cid: "bafyreirecord",
			blobs: ["bafkreiaaa"],
		});
		expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
		expect(response.headers.get("cache-tag")).toBe(
			`did:${DID},rec:${DID}/${COLLECTION}/${RKEY},${version}`,
		);
	});

	it("rejects malformed references", async () => {
		expect((await exports.Record.fetch(`http://record/record/${DID}/nope/${RKEY}`)).status).toBe(
			400,
		);
		expect((await exports.Record.fetch(`http://record/record/${DID}/${COLLECTION}`)).status).toBe(
			400,
		);
	});
});
