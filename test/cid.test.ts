import { describe, expect, it } from "vitest";
import {
	base32Decode,
	base32Encode,
	decodeBlobCid,
	digestsEqual,
	encodeBlobCid,
} from "../src/cid.ts";

const REAL_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

describe("base32", () => {
	it("round-trips bytes", () => {
		const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 42]);
		expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
	});

	it("rejects characters outside the alphabet", () => {
		expect(() => base32Decode("abc1")).toThrow();
		expect(() => base32Decode("ABCD")).toThrow();
	});
});

describe("decodeBlobCid", () => {
	it("decodes a raw sha2-256 CIDv1", () => {
		const digest = decodeBlobCid(REAL_CID);
		expect(digest.length).toBe(32);
		expect(encodeBlobCid(digest)).toBe(REAL_CID);
	});

	it("rejects non-base32 multibase prefixes", () => {
		expect(() => decodeBlobCid("zQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toThrow(
			/base32/,
		);
		expect(() => decodeBlobCid(REAL_CID.toUpperCase())).toThrow(/base32/);
	});

	it("rejects other codecs and hashes", () => {
		const digest = decodeBlobCid(REAL_CID);
		const dagCbor = new Uint8Array([0x01, 0x71, 0x12, 0x20, ...digest]);
		expect(() => decodeBlobCid("b" + base32Encode(dagCbor))).toThrow(/codec/);
		const sha512 = new Uint8Array([0x01, 0x55, 0x13, 0x20, ...digest]);
		expect(() => decodeBlobCid("b" + base32Encode(sha512))).toThrow(/sha2-256/);
		const truncated = new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest.subarray(0, 31)]);
		expect(() => decodeBlobCid("b" + base32Encode(truncated))).toThrow(/trailing|length/);
		const v0 = new Uint8Array([0x12, 0x20, ...digest]);
		expect(() => decodeBlobCid("b" + base32Encode(v0))).toThrow(/version/);
	});
});

describe("digestsEqual", () => {
	it("compares byte-wise", () => {
		const a = new Uint8Array([1, 2, 3]);
		expect(digestsEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
		expect(digestsEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
		expect(digestsEqual(a, new Uint8Array([1, 2]))).toBe(false);
	});
});
