import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DID, PDS, cidFor, didDocument, pngBytes, stubFetch, type FetchStub } from "./helpers.ts";

const ORIGIN = "https://cumulus.example";
const PLC_HOST = "plc.directory";
const PDS_HOST = new URL(PDS).hostname;

const blob = pngBytes(4096);
let cid: string;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function pdsServing(bytes: Uint8Array, headers: Record<string, string> = {}): FetchStub {
	return (url) => {
		expect(url.pathname).toBe("/xrpc/com.atproto.sync.getBlob");
		expect(url.search).toBe(`?did=${encodeURIComponent(DID)}&cid=${url.searchParams.get("cid")}`);
		return new Response(bytes, { headers: { "content-type": "image/svg+xml", ...headers } });
	};
}

function useFetch(routes: Record<string, FetchStub>): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(stubFetch(routes));
}

const get = (path: string, init?: RequestInit) =>
	exports.default.fetch(new Request(ORIGIN + path, { redirect: "manual", ...init }));

beforeEach(async () => {
	cid = await cidFor(blob);
});
afterEach(() => vi.restoreAllMocks());

describe("blob route", () => {
	it("serves a verified blob with the full header contract", async () => {
		useFetch({ [PLC_HOST]: () => json(didDocument()), [PDS_HOST]: pdsServing(blob) });
		const response = await get(`/${DID}/${cid}`);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(blob);
		const h = response.headers;
		expect(h.get("content-type")).toBe("image/png");
		expect(h.get("content-length")).toBe("4096");
		expect(h.get("accept-ranges")).toBe("bytes");
		expect(h.get("cache-control")).toBe("public, max-age=3600");
		expect(h.get("cloudflare-cdn-cache-control")).toBe("max-age=31536000, immutable");
		expect(h.get("cache-tag")).toBe(`did:${DID},cid:${cid}`);
		expect(h.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(h.get("x-content-type-options")).toBe("nosniff");
		expect(h.get("cross-origin-resource-policy")).toBe("cross-origin");
		expect(h.get("content-disposition")).toBe(`inline; filename="${cid}.png"`);
		expect(h.has("vary")).toBe(false);
	});

	it("ignores Range and never returns 206", async () => {
		useFetch({ [PLC_HOST]: () => json(didDocument()), [PDS_HOST]: pdsServing(blob) });
		const response = await get(`/${DID}/${cid}`, { headers: { range: "bytes=0-9" } });
		expect(response.status).toBe(200);
		expect((await response.arrayBuffer()).byteLength).toBe(4096);
	});

	it("answers HEAD with headers only", async () => {
		useFetch({ [PLC_HOST]: () => json(didDocument()), [PDS_HOST]: pdsServing(blob) });
		const response = await get(`/${DID}/${cid}`, { method: "HEAD" });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},cid:${cid}`);
		expect(await response.text()).toBe("");
	});

	it("resolves did:web through did.json", async () => {
		const did = "did:web:alice.example.org";
		useFetch({
			"alice.example.org": (url) => {
				expect(url.pathname).toBe("/.well-known/did.json");
				return json(didDocument(did));
			},
			[PDS_HOST]: (url) => {
				expect(url.searchParams.get("did")).toBe(did);
				return new Response(blob);
			},
		});
		const response = await get(`/${did}/${cid}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-tag")).toBe(`did:${did},cid:${cid}`);
	});

	it("rejects bytes that do not match the CID with an uncacheable 502", async () => {
		const tampered = pngBytes(4096);
		tampered[100] = ~tampered[100]! & 0xff;
		useFetch({ [PLC_HOST]: () => json(didDocument()), [PDS_HOST]: pdsServing(tampered) });
		const response = await get(`/${DID}/${cid}`);
		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.has("cache-tag")).toBe(false);
	});

	it("returns 415 for verified bytes of a disallowed type", async () => {
		const svg = new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
		);
		const svgCid = await cidFor(svg);
		useFetch({ [PLC_HOST]: () => json(didDocument()), [PDS_HOST]: pdsServing(svg) });
		const response = await get(`/${DID}/${svgCid}`);
		expect(response.status).toBe(415);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},cid:${svgCid}`);
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
	});

	it("returns a tagged 413 when Content-Length exceeds the limit", async () => {
		useFetch({
			[PLC_HOST]: () => json(didDocument()),
			[PDS_HOST]: pdsServing(blob, { "content-length": String(30 * 1024 * 1024) }),
		});
		const response = await get(`/${DID}/${cid}`);
		expect(response.status).toBe(413);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},cid:${cid}`);
	});

	it("returns 413 when the body outgrows the limit regardless of Content-Length", async () => {
		const huge = pngBytes(26 * 1024 * 1024);
		const hugeCid = await cidFor(huge);
		useFetch({
			[PLC_HOST]: () => json(didDocument()),
			[PDS_HOST]: () => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						for (let offset = 0; offset < huge.length; offset += 1024 * 1024) {
							controller.enqueue(huge.subarray(offset, offset + 1024 * 1024));
						}
						controller.close();
					},
				});
				return new Response(stream);
			},
		});
		const response = await get(`/${DID}/${hugeCid}`);
		expect(response.status).toBe(413);
	});

	it("returns a tagged short-lived 404 for a missing blob", async () => {
		useFetch({
			[PLC_HOST]: () => json(didDocument()),
			[PDS_HOST]: () => json({ error: "BlobNotFound", message: "Blob not found" }, 400),
		});
		const response = await get(`/${DID}/${cid}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},cid:${cid}`);
	});

	it("returns a did-tagged short-lived 404 for an unknown DID", async () => {
		useFetch({ [PLC_HOST]: () => json({ message: "DID not registered" }, 404) });
		const response = await get(`/${DID}/${cid}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get("cache-tag")).toBe(`did:${DID}`);
	});

	it("returns 404 when the DID document redirects", async () => {
		useFetch({
			"alice.example.org": (_url, init) => {
				expect(init?.redirect).toBe("manual");
				return new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/did.json" },
				});
			},
		});
		const response = await get(`/did:web:alice.example.org/${cid}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
	});

	it("returns 404 for a DID document without a usable https PDS", async () => {
		useFetch({ [PLC_HOST]: () => json(didDocument(DID, "http://10.0.0.1:3000")) });
		const response = await get(`/${DID}/${cid}`);
		expect(response.status).toBe(404);
	});

	it("returns an uncacheable 502 when the PDS fails", async () => {
		useFetch({
			[PLC_HOST]: () => json(didDocument()),
			[PDS_HOST]: () => new Response("upstream broke", { status: 503 }),
		});
		const response = await get(`/${DID}/${cid}`);
		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("returns an uncacheable 502 when the directory fails", async () => {
		useFetch({ [PLC_HOST]: () => new Response("nope", { status: 500 }) });
		const response = await get(`/${DID}/${cid}`);
		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("never contacts the network for structurally wrong CIDs", async () => {
		useFetch({});
		const response = await get(
			`/${DID}/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`,
		);
		expect(response.status).toBe(400);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
	});
});

describe("routing", () => {
	it("redirects non-canonical paths with explicit Cache-Control", async () => {
		useFetch({});
		const response = await get(`/${DID}/${cid.toUpperCase()}`);
		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe(`/${DID}/${cid}`);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
	});

	it("returns 400 for malformed DID or CID", async () => {
		useFetch({});
		const response = await get(`/did:plc:nope/${cid}`);
		expect(response.status).toBe(400);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
	});

	it("returns 404 for unknown routes", async () => {
		useFetch({});
		for (const path of [
			"/",
			"/favicon.ico",
			`/${DID}`,
			`/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${cid}`,
		]) {
			const response = await get(path);
			expect(response.status, path).toBe(404);
			expect(response.headers.get("cache-control"), path).toBe("public, max-age=300");
		}
	});

	it("rejects other methods with no-store", async () => {
		useFetch({});
		const response = await get(`/${DID}/${cid}`, { method: "POST" });
		expect(response.status).toBe(405);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("allow")).toBe("GET, HEAD");
	});

	it("serves an uncacheable health check", async () => {
		useFetch({});
		const response = await get("/healthz");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});
