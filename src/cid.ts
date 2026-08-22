const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const CID_VERSION_1 = 0x01;
const CODEC_RAW = 0x55;
const MULTIHASH_SHA2_256 = 0x12;
const SHA2_256_LENGTH = 32;

export const CID_PATTERN = /^b[a-z2-7]+$/;

export function base32Decode(input: string): Uint8Array {
	const out = new Uint8Array(Math.floor((input.length * 5) / 8));
	let bits = 0;
	let value = 0;
	let index = 0;
	for (const char of input) {
		const digit = BASE32_ALPHABET.indexOf(char);
		if (digit === -1) throw new Error("Invalid base32 character");
		value = (value << 5) | digit;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out[index++] = (value >>> bits) & 0xff;
		}
	}
	if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) {
		throw new Error("Invalid base32 padding");
	}
	return out;
}

export function base32Encode(bytes: Uint8Array): string {
	let out = "";
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
	}
	return out;
}

function readVarint(bytes: Uint8Array, offset: number): [value: number, next: number] {
	let value = 0;
	let shift = 0;
	for (let i = offset; i < bytes.length; i++) {
		const byte = bytes[i]!;
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return [value, i + 1];
		shift += 7;
		if (shift > 28) break;
	}
	throw new Error("Invalid varint");
}

/**
 * Decodes a CIDv1 in multibase base32 and returns its SHA-256 digest. Only the
 * exact shape ATProto blobs use is accepted: version 1, codec raw, multihash
 * sha2-256 with a 32-byte digest.
 */
export function decodeBlobCid(cid: string): Uint8Array {
	if (!CID_PATTERN.test(cid)) throw new Error("CID must be multibase base32");
	const bytes = base32Decode(cid.slice(1));
	let offset = 0;
	let value: number;
	[value, offset] = readVarint(bytes, offset);
	if (value !== CID_VERSION_1) throw new Error("CID must be version 1");
	[value, offset] = readVarint(bytes, offset);
	if (value !== CODEC_RAW) throw new Error("CID codec must be raw");
	[value, offset] = readVarint(bytes, offset);
	if (value !== MULTIHASH_SHA2_256) throw new Error("CID multihash must be sha2-256");
	[value, offset] = readVarint(bytes, offset);
	if (value !== SHA2_256_LENGTH) throw new Error("CID digest length must be 32");
	if (bytes.length !== offset + SHA2_256_LENGTH) throw new Error("CID has trailing bytes");
	return bytes.subarray(offset);
}

export function encodeBlobCid(digest: Uint8Array): string {
	if (digest.length !== SHA2_256_LENGTH) throw new Error("Digest must be 32 bytes");
	const bytes = new Uint8Array(4 + SHA2_256_LENGTH);
	bytes.set([CID_VERSION_1, CODEC_RAW, MULTIHASH_SHA2_256, SHA2_256_LENGTH]);
	bytes.set(digest, 4);
	return "b" + base32Encode(bytes);
}

export function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}
