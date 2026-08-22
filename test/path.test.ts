import { describe, expect, it } from "vitest";
import { parseBlobPath } from "../src/path.ts";

const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const PLC = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";

describe("parseBlobPath", () => {
	it("accepts canonical did:plc and did:web paths", () => {
		expect(parseBlobPath(`/${PLC}/${CID}`)).toEqual({ kind: "blob", did: PLC, cid: CID });
		expect(parseBlobPath(`/did:web:example.com/${CID}`)).toEqual({
			kind: "blob",
			did: "did:web:example.com",
			cid: CID,
		});
		expect(parseBlobPath(`/did:web:example.com%3a8443:user:Alice/${CID}`)).toEqual({
			kind: "blob",
			did: "did:web:example.com%3a8443:user:Alice",
			cid: CID,
		});
		expect(parseBlobPath(`/did:web:example.com%3A8443/${CID}`)).toEqual({
			kind: "redirect",
			location: `/did:web:example.com%3a8443/${CID}`,
		});
	});

	it("redirects aliases to the canonical path", () => {
		const canonical = `/${PLC}/${CID}`;
		expect(parseBlobPath(`/${PLC}/${CID}/`)).toEqual({ kind: "redirect", location: canonical });
		expect(parseBlobPath(`//${PLC}//${CID}`)).toEqual({ kind: "redirect", location: canonical });
		expect(parseBlobPath(`/${PLC}/${CID.toUpperCase()}`)).toEqual({
			kind: "redirect",
			location: canonical,
		});
		expect(parseBlobPath(`/${PLC.replace(/:/g, "%3A")}/${CID}`)).toEqual({
			kind: "redirect",
			location: canonical,
		});
		expect(parseBlobPath(`/DID:WEB:Example.COM/${CID}`)).toEqual({
			kind: "redirect",
			location: `/did:web:example.com/${CID}`,
		});
	});

	it("rejects malformed DIDs and CIDs", () => {
		expect(parseBlobPath(`/${PLC.toUpperCase()}/${CID}`)).toEqual({ kind: "invalid" });
		expect(parseBlobPath(`/did:plc:tooshort/${CID}`)).toEqual({ kind: "invalid" });
		expect(parseBlobPath(`/did:key:z6Mk/${CID}`)).toEqual({ kind: "invalid" });
		expect(parseBlobPath(`/did:web:localhost/${CID}`)).toEqual({ kind: "invalid" });
		expect(parseBlobPath(`/did:web:exa_mple.com/${CID}`)).toEqual({ kind: "invalid" });
		expect(parseBlobPath(`/${PLC}/${CID}x`)).toEqual({ kind: "blob", did: PLC, cid: `${CID}x` });
		expect(parseBlobPath(`/${PLC}/${CID.slice(0, -1)}1`)).toEqual({ kind: "invalid" });
		expect(parseBlobPath(`/${PLC}/zQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`)).toEqual({
			kind: "invalid",
		});
		expect(parseBlobPath(`/${PLC}/bAfKrei`)).toEqual({ kind: "invalid" });
		expect(parseBlobPath(`/${PLC}/%E0%A4%A`)).toEqual({ kind: "invalid" });
	});

	it("treats other shapes as unknown routes", () => {
		expect(parseBlobPath("/")).toEqual({ kind: "unknown" });
		expect(parseBlobPath(`/${PLC}`)).toEqual({ kind: "unknown" });
		expect(parseBlobPath(`/${PLC}/${CID}/extra`)).toEqual({ kind: "unknown" });
		expect(parseBlobPath("/xrpc/com.atproto.sync.getBlob")).toEqual({ kind: "unknown" });
		expect(parseBlobPath(`/Did:plc:nope/${CID}`)).toEqual({ kind: "invalid" });
	});
});
