import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseImgPath } from "../src/img.ts";
import { DID, PDS, cidFor, didDocument, pngBytes, stubFetch } from "./helpers.ts";

const ORIGIN = "https://cumulus.example";
const PDS_HOST = new URL(PDS).hostname;
const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const version = `v:${env.VERSION.id}`;

interface Call {
	transforms: ImageTransform[];
	output?: ImageOutputOptions;
	input: Uint8Array;
}

function fakeImages(calls: Call[], fail = false): ImagesBinding {
	const binding = {
		input(stream: ReadableStream<Uint8Array>) {
			const call: Call = { transforms: [], input: new Uint8Array() };
			calls.push(call);
			const transformer = {
				transform(transform: ImageTransform) {
					call.transforms.push(transform);
					return transformer;
				},
				draw() {
					return transformer;
				},
				async output(options: ImageOutputOptions) {
					call.input = new Uint8Array(await new Response(stream).arrayBuffer());
					call.output = options;
					if (fail) throw new Error("ERROR 9412: not an image");
					const bytes = new Uint8Array([
						0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
					]);
					return {
						contentType: () => options.format,
						image: () => new Response(bytes).body!,
						response: () => new Response(bytes, { headers: { "content-type": options.format } }),
					};
				},
			};
			return transformer;
		},
	};
	return binding as unknown as ImagesBinding;
}

function withImages(binding: ImagesBinding | undefined): () => void {
	const mutable = env as unknown as { IMAGES?: ImagesBinding };
	const previous = mutable.IMAGES;
	if (binding) mutable.IMAGES = binding;
	else delete mutable.IMAGES;
	return () => {
		if (previous) mutable.IMAGES = previous;
		else delete mutable.IMAGES;
	};
}

describe("parseImgPath", () => {
	it("parses canonical preset paths with optional format", () => {
		expect(parseImgPath(`/img/avatar/plain/${DID}/${CID}`, "open")).toMatchObject({
			kind: "img",
			preset: "avatar",
			did: DID,
			cid: CID,
			format: undefined,
			original: `/${DID}/${CID}`,
		});
		expect(parseImgPath(`/img/feed_thumbnail/plain/${DID}/${CID}@jpeg`, "open")).toMatchObject({
			kind: "img",
			preset: "feed_thumbnail",
			format: "jpeg",
		});
	});

	it("redirects aliases to the canonical preset path", () => {
		expect(parseImgPath(`/img/avatar/plain/${DID}/${CID.toUpperCase()}`, "open")).toEqual({
			kind: "redirect",
			location: `/img/avatar/plain/${DID}/${CID}`,
		});
		expect(parseImgPath(`/img/avatar/plain/${DID}/${CID}@WEBP`, "open")).toEqual({
			kind: "redirect",
			location: `/img/avatar/plain/${DID}/${CID}@webp`,
		});
	});

	it("parses scoped preset paths in scoped mode only", () => {
		const scoped = `/img/avatar/r/${DID}/app.example.post/3k/${CID}`;
		expect(parseImgPath(scoped, "scoped")).toMatchObject({
			kind: "img",
			original: `/r/${DID}/app.example.post/3k/${CID}`,
			tags: [`did:${DID}`, `cid:${CID}`, `rec:${DID}/app.example.post/3k`],
		});
		expect(
			parseImgPath(`${scoped.slice(0, -CID.length)}${CID.toUpperCase()}@png`, "scoped"),
		).toEqual({
			kind: "redirect",
			location: `${scoped}@png`,
		});
		expect(parseImgPath(scoped, "open")).toEqual({ kind: "unknown" });
		expect(parseImgPath(`/img/avatar/plain/${DID}/${CID}`, "scoped")).toEqual({ kind: "unknown" });
	});

	it("rejects unknown presets, formats and malformed identifiers", () => {
		expect(parseImgPath(`/img/huge/plain/${DID}/${CID}`, "open")).toEqual({ kind: "invalid" });
		expect(parseImgPath(`/img/avatar/plain/${DID}/${CID}@gif`, "open")).toEqual({
			kind: "invalid",
		});
		expect(parseImgPath(`/img/avatar/plain/did:plc:nope/${CID}`, "open")).toEqual({
			kind: "invalid",
		});
		expect(parseImgPath(`/img/avatar/plain/${DID}`, "open")).toEqual({ kind: "invalid" });
		expect(parseImgPath(`/img/avatar/${DID}/${CID}`, "open")).toEqual({ kind: "unknown" });
		expect(parseImgPath("/img/", "open")).toEqual({ kind: "unknown" });
	});
});

describe("/img route", () => {
	const image = pngBytes(512);
	let restore: () => void;
	afterEach(() => {
		restore?.();
		vi.restoreAllMocks();
	});

	function stubOrigin(): void {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(didDocument()),
				[PDS_HOST]: () => new Response(image),
			}),
		);
	}

	it("transforms the verified original with the preset's options", async () => {
		const calls: Call[] = [];
		restore = withImages(fakeImages(calls));
		stubOrigin();
		const cid = await cidFor(image);
		const response = await exports.default.fetch(`${ORIGIN}/img/banner/plain/${DID}/${cid}@jpeg`);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.input).toEqual(image);
		expect(calls[0]!.transforms).toEqual([{ fit: "cover", width: 3000, height: 1000 }]);
		expect(calls[0]!.output).toEqual({ format: "image/jpeg" });
		const h = response.headers;
		expect(h.get("content-type")).toBe("image/jpeg");
		expect(h.get("cache-control")).toBe("public, max-age=3600");
		expect(h.get("cloudflare-cdn-cache-control")).toBe("max-age=31536000, immutable");
		expect(h.get("cache-tag")).toBe(`did:${DID},cid:${cid},${version}`);
		expect(h.get("content-disposition")).toBe(`inline; filename="${cid}.jpg"`);
		expect(h.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(h.get("accept-ranges")).toBe("bytes");
	});

	it("defaults to webp and maps inside presets to contain", async () => {
		const calls: Call[] = [];
		restore = withImages(fakeImages(calls));
		stubOrigin();
		const cid = await cidFor(image);
		const response = await exports.default.fetch(`${ORIGIN}/img/feed_fullsize/plain/${DID}/${cid}`);
		expect(response.status).toBe(200);
		expect(calls[0]!.transforms).toEqual([{ fit: "contain", width: 1000, height: 1000 }]);
		expect(calls[0]!.output).toEqual({ format: "image/webp", anim: true });
		expect(response.headers.get("content-disposition")).toBe(`inline; filename="${cid}.webp"`);
	});

	it("passes the original's error responses through untouched", async () => {
		const calls: Call[] = [];
		restore = withImages(fakeImages(calls));
		vi.spyOn(globalThis, "fetch").mockImplementation(
			stubFetch({
				"plc.directory": () => Response.json(didDocument()),
				[PDS_HOST]: () => Response.json({ error: "BlobNotFound" }, { status: 400 }),
			}),
		);
		const response = await exports.default.fetch(`${ORIGIN}/img/avatar/plain/${DID}/${CID}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(calls).toHaveLength(0);
	});

	it("returns an uncacheable 502 when the transform fails", async () => {
		restore = withImages(fakeImages([], true));
		stubOrigin();
		const cid = await cidFor(image);
		const response = await exports.default.fetch(`${ORIGIN}/img/avatar/plain/${DID}/${cid}`);
		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("404s when no Images binding is configured", async () => {
		restore = withImages(undefined);
		stubOrigin();
		const response = await exports.default.fetch(`${ORIGIN}/img/avatar/plain/${DID}/${CID}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
	});

	it("redirects and rejects like the blob route", async () => {
		restore = withImages(fakeImages([]));
		const redirect = await exports.default.fetch(
			new Request(`${ORIGIN}/img/avatar/plain/${DID}/${CID.toUpperCase()}`, { redirect: "manual" }),
		);
		expect(redirect.status).toBe(301);
		expect(redirect.headers.get("location")).toBe(`/img/avatar/plain/${DID}/${CID}`);
		const bad = await exports.default.fetch(`${ORIGIN}/img/nope/plain/${DID}/${CID}`);
		expect(bad.status).toBe(400);
		expect(bad.headers.get("cache-control")).toBe("public, max-age=86400");
	});
});
