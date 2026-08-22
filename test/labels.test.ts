import { describe, expect, it } from "vitest";
import { serviceFromDidDocument } from "../src/identity.ts";
import {
	blobRefs,
	isEnforced,
	parseLabelers,
	parseRecordUri,
	queryLabelsUrl,
	type Label,
} from "../src/labels.ts";

const LABELER = { did: "did:plc:ar7c4by46qjdydhdevvrndac", vals: ["!takedown", "!hide"] };
const NOW = Date.parse("2026-08-22T12:00:00Z");

function label(overrides: Partial<Label>): Label {
	return {
		src: LABELER.did,
		uri: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
		val: "!takedown",
		cts: "2026-08-22T11:00:00Z",
		...overrides,
	};
}

describe("parseLabelers", () => {
	it("parses the JSON config", () => {
		expect(parseLabelers("")).toEqual([]);
		expect(parseLabelers(JSON.stringify([LABELER]))).toEqual([LABELER]);
	});

	it("rejects malformed config loudly", () => {
		expect(() => parseLabelers("{")).toThrow(/JSON/);
		expect(() => parseLabelers("{}")).toThrow(/array/);
		expect(() => parseLabelers('[{"did":"nope","vals":["x"]}]')).toThrow(/did/);
		expect(() => parseLabelers('[{"did":"did:plc:x","vals":[]}]')).toThrow(/vals/);
	});
});

describe("isEnforced", () => {
	it("matches source and value", () => {
		expect(isEnforced(label({}), LABELER, NOW)).toBe(true);
		expect(isEnforced(label({ val: "porn" }), LABELER, NOW)).toBe(false);
		expect(isEnforced(label({ src: "did:plc:someoneelse" }), LABELER, NOW)).toBe(false);
	});

	it("ignores negations and expired labels", () => {
		expect(isEnforced(label({ neg: true }), LABELER, NOW)).toBe(false);
		expect(isEnforced(label({ exp: "2026-08-22T11:30:00Z" }), LABELER, NOW)).toBe(false);
		expect(isEnforced(label({ exp: "2026-08-23T00:00:00Z" }), LABELER, NOW)).toBe(true);
	});
});

describe("parseRecordUri", () => {
	it("splits at:// record URIs", () => {
		expect(
			parseRecordUri("at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.post/3k2abc"),
		).toEqual({
			did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
			collection: "app.bsky.feed.post",
			rkey: "3k2abc",
		});
		expect(parseRecordUri("did:plc:ewvi7nxzyoun6zhxrhs64oiz")).toBeUndefined();
		expect(parseRecordUri("at://did:plc:x")).toBeUndefined();
	});
});

describe("blobRefs", () => {
	it("walks nested records for blob links", () => {
		const record = {
			$type: "app.bsky.feed.post",
			embed: {
				$type: "app.bsky.embed.images",
				images: [
					{
						alt: "",
						image: { $type: "blob", ref: { $link: "bafkreiaaa" }, mimeType: "image/png", size: 1 },
					},
					{
						alt: "",
						image: { $type: "blob", ref: { $link: "bafkreibbb" }, mimeType: "image/png", size: 1 },
					},
				],
			},
			thumb: { $type: "blob", ref: { $link: "bafkreiaaa" } },
		};
		expect([...blobRefs(record)]).toEqual(["bafkreiaaa", "bafkreibbb"]);
		expect([...blobRefs({ text: "no blobs" })]).toEqual([]);
	});
});

describe("queryLabelsUrl", () => {
	it("builds the xrpc query", () => {
		expect(queryLabelsUrl("https://mod.bsky.app", "did:plc:abc", LABELER.did)).toBe(
			`https://mod.bsky.app/xrpc/com.atproto.label.queryLabels?uriPatterns=did%3Aplc%3Aabc&sources=${encodeURIComponent(LABELER.did)}&limit=250`,
		);
	});
});

describe("serviceFromDidDocument", () => {
	const doc = {
		id: LABELER.did,
		service: [
			{
				id: "#atproto_pds",
				type: "AtprotoPersonalDataServer",
				serviceEndpoint: "https://pds.example",
			},
			{ id: "#atproto_labeler", type: "AtprotoLabeler", serviceEndpoint: "https://mod.bsky.app/" },
		],
	};

	it("extracts the labeler service", () => {
		expect(serviceFromDidDocument(LABELER.did, doc, "labeler")).toBe("https://mod.bsky.app");
		expect(serviceFromDidDocument(LABELER.did, doc, "pds")).toBe("https://pds.example");
		expect(serviceFromDidDocument("did:plc:other", doc, "labeler")).toBeUndefined();
	});
});
