import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DID, PDS, cidFor, didDocument, pngBytes, stubFetch } from "./helpers.ts";

const ORIGIN = "https://cumulus.example";
const PDS_HOST = new URL(PDS).hostname;
const version = `v:${env.VERSION.id}`;

afterEach(() => vi.restoreAllMocks());

function png(width: number, height: number): Uint8Array {
	const bytes = pngBytes(256);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
	bytes.set([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54], 33);
	return bytes;
}

describe("/metadata", () => {
	it("derives metadata from the verified original via loopback", async () => {
		const image = png(640, 480);
		const cid = await cidFor(image);
		let pdsFetches = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(didDocument()),
				[PDS_HOST]: () => {
					pdsFetches++;
					return new Response(image);
				},
			}),
		);
		const response = await exports.default.fetch(`${ORIGIN}/metadata/${DID}/${cid}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			mime: "image/png",
			ext: "png",
			size: 256,
			width: 640,
			height: 480,
			animated: false,
		});
		expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
		expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
			"max-age=31536000, immutable",
		);
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},cid:${cid},${version}`);
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(pdsFetches).toBe(1);
	});

	it("passes the original's error responses through", async () => {
		const cid = await cidFor(pngBytes(16));
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(didDocument()),
				[PDS_HOST]: () => Response.json({ error: "BlobNotFound" }, { status: 400 }),
			}),
		);
		const response = await exports.default.fetch(`${ORIGIN}/metadata/${DID}/${cid}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get("cache-tag")).toBe(`did:${DID},cid:${cid},${version}`);
	});

	it("redirects non-canonical metadata paths under /metadata", async () => {
		const cid = await cidFor(pngBytes(16));
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}/metadata/${DID}/${cid.toUpperCase()}`, { redirect: "manual" }),
		);
		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe(`/metadata/${DID}/${cid}`);
	});
});
