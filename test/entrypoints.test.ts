import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DID, PDS, didDocument, stubFetch } from "./helpers.ts";

const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const version = `v:${env.VERSION.id}`;

afterEach(() => vi.restoreAllMocks());

describe("Identity", () => {
	it("resolves a DID to its PDS with SWR caching and tags", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({ "plc.directory": () => Response.json(didDocument()) }),
		);
		const response = await exports.Identity.fetch(`http://identity/did/${DID}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ pds: PDS });
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=3600, stale-while-revalidate=86400",
		);
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},${version}`);
	});

	it("returns a tagged short-lived 404 for unknown DIDs", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({ "plc.directory": () => new Response("nope", { status: 404 }) }),
		);
		const response = await exports.Identity.fetch(`http://identity/did/${DID}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},${version}`);
	});

	it("returns an uncacheable 502 when the directory fails", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({ "plc.directory": () => new Response("down", { status: 503 }) }),
		);
		const response = await exports.Identity.fetch(`http://identity/did/${DID}`);
		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("resolves a labeler service endpoint", async () => {
		const labeler = "did:plc:ar7c4by46qjdydhdevvrndac";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () =>
					Response.json({
						id: labeler,
						service: [
							{
								id: "#atproto_labeler",
								type: "AtprotoLabeler",
								serviceEndpoint: "https://mod.bsky.app",
							},
						],
					}),
			}),
		);
		const response = await exports.Identity.fetch(`http://identity/labeler/${labeler}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ endpoint: "https://mod.bsky.app" });
		expect(response.headers.get("cache-tag")).toBe(`did:${labeler},${version}`);
		expect((await exports.Identity.fetch(`http://identity/did/${labeler}`)).status).toBe(404);
	});

	it("rejects malformed DIDs without touching the network", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(stubFetch({}));
		const response = await exports.Identity.fetch("http://identity/did/did:plc:nope");
		expect(response.status).toBe(400);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
	});
});

describe("Policy", () => {
	it("allows with a one-hour verdict and blob tags", async () => {
		const response = await exports.Policy.fetch(`http://policy/check/${DID}/${CID}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ allow: true });
		expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},cid:${CID},${version}`);
	});

	it("rejects malformed paths", async () => {
		expect((await exports.Policy.fetch(`http://policy/check/${DID}`)).status).toBe(400);
		expect((await exports.Policy.fetch(`http://policy/check/${DID}/BAD`)).status).toBe(400);
	});
});
