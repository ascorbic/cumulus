import { describe, expect, it } from "vitest";
import { decodeCbor, decodeCborSequence } from "../src/cbor.ts";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe("decodeCbor", () => {
	it("decodes scalars", () => {
		expect(decodeCbor(hex("00"))).toBe(0);
		expect(decodeCbor(hex("17"))).toBe(23);
		expect(decodeCbor(hex("1818"))).toBe(24);
		expect(decodeCbor(hex("190100"))).toBe(256);
		expect(decodeCbor(hex("1a00010000"))).toBe(65536);
		expect(decodeCbor(hex("1b000000e8d4a51000"))).toBe(1_000_000_000_000);
		expect(decodeCbor(hex("20"))).toBe(-1);
		expect(decodeCbor(hex("3863"))).toBe(-100);
		expect(decodeCbor(hex("f4"))).toBe(false);
		expect(decodeCbor(hex("f5"))).toBe(true);
		expect(decodeCbor(hex("f6"))).toBe(null);
		expect(decodeCbor(hex("fb3ff199999999999a"))).toBeCloseTo(1.1);
	});

	it("decodes strings, bytes, arrays and maps", () => {
		expect(decodeCbor(hex("6449455446"))).toBe("IETF");
		expect(decodeCbor(hex("4401020304"))).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(decodeCbor(hex("83010203"))).toEqual([1, 2, 3]);
		expect(decodeCbor(hex("a26161016162820203"))).toEqual({ a: 1, b: [2, 3] });
	});

	it("decodes tag 42 CID links", () => {
		const cid = "01551220" + "ab".repeat(32);
		const encoded = hex("d82a" + "5825" + "00" + cid);
		const value = decodeCbor(encoded) as { $link: Uint8Array };
		expect(value.$link).toEqual(hex(cid));
	});

	it("rejects malformed input", () => {
		expect(() => decodeCbor(hex("18"))).toThrow(/end/);
		expect(() => decodeCbor(hex("0000"))).toThrow(/Trailing/);
		expect(() => decodeCbor(hex("9f01ff"))).toThrow();
		expect(() => decodeCbor(hex("a1010a"))).toThrow(/keys/);
		expect(() => decodeCbor(hex("c001"))).toThrow(/tag/);
	});

	it("decodes concatenated frames", () => {
		const header = "a2626f7001617465" + "2366726f6f"; // {op: 1, t: "#froo"}
		const body = "a16373657118c8"; // {seq: 200}
		expect(decodeCborSequence(hex(header + body))).toEqual([{ op: 1, t: "#froo" }, { seq: 200 }]);
	});
});
