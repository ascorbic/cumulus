import { describe, expect, it } from "vitest";
import { imageInfo } from "../src/dimensions.ts";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

function box(type: string, payload: number[] | number[][], full = false): number[] {
	const body = [...(full ? [0, 0, 0, 0] : []), ...payload.flat()];
	return [...u32be(8 + body.length), ...ascii(type), ...body];
}

describe("imageInfo", () => {
	it("reads JPEG SOF0 after an APP0 segment", () => {
		const app0 = [0xff, 0xe0, ...u16be(16), ...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
		const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(480), ...u16be(640), 3];
		const bytes = new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0, 0, 0]);
		expect(imageInfo(bytes, "image/jpeg")).toEqual({ width: 640, height: 480, animated: false });
	});

	it("reads JPEG SOF2 (progressive) and skips a DHT segment", () => {
		const dht = [0xff, 0xc4, ...u16be(4), 0, 0];
		const sof2 = [0xff, 0xc2, ...u16be(11), 8, ...u16be(10), ...u16be(20), 1];
		const bytes = new Uint8Array([0xff, 0xd8, ...dht, ...sof2, 0, 0, 0]);
		expect(imageInfo(bytes, "image/jpeg")).toEqual({ width: 20, height: 10, animated: false });
	});

	it("reads PNG IHDR and detects APNG via acTL", () => {
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		const ihdr = [
			...u32be(13),
			...ascii("IHDR"),
			...u32be(300),
			...u32be(200),
			8,
			6,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
		];
		const actl = [...u32be(8), ...ascii("acTL"), ...u32be(3), ...u32be(0), 0, 0, 0, 0];
		const idat = [...u32be(0), ...ascii("IDAT"), 0, 0, 0, 0];
		expect(imageInfo(new Uint8Array([...sig, ...ihdr, ...idat]), "image/png")).toEqual({
			width: 300,
			height: 200,
			animated: false,
		});
		expect(imageInfo(new Uint8Array([...sig, ...ihdr, ...actl, ...idat]), "image/png")).toEqual({
			width: 300,
			height: 200,
			animated: true,
		});
	});

	it("reads GIF logical screen size and counts frames", () => {
		const header = [...ascii("GIF89a"), ...u16le(50), ...u16le(40), 0x00, 0, 0];
		const frame = [0x2c, 0, 0, 0, 0, ...u16le(50), ...u16le(40), 0x00, 2, 1, 0x44, 0];
		const gce = [0x21, 0xf9, 4, 0, 0, 0, 0, 0];
		const trailer = [0x3b];
		expect(imageInfo(new Uint8Array([...header, ...frame, ...trailer]), "image/gif")).toEqual({
			width: 50,
			height: 40,
			animated: false,
		});
		expect(
			imageInfo(
				new Uint8Array([...header, ...gce, ...frame, ...gce, ...frame, ...trailer]),
				"image/gif",
			),
		).toEqual({ width: 50, height: 40, animated: true });
	});

	it("reads WebP VP8, VP8L and VP8X headers", () => {
		const riff = (chunk: number[]) =>
			new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...chunk]);
		const vp8 = [
			...ascii("VP8 "),
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0x9d,
			0x01,
			0x2a,
			...u16le(320),
			...u16le(240),
			0,
			0,
		];
		expect(imageInfo(riff(vp8), "image/webp")).toEqual({
			width: 320,
			height: 240,
			animated: false,
		});
		// VP8L: 14 bits width-1, 14 bits height-1, little-endian after the 0x2f signature.
		const w = 320 - 1;
		const h = 240 - 1;
		const bits = w | (h << 14);
		const vp8l = [
			...ascii("VP8L"),
			0,
			0,
			0,
			0,
			0x2f,
			bits & 0xff,
			(bits >> 8) & 0xff,
			(bits >> 16) & 0xff,
			(bits >>> 24) & 0xff,
			0,
			0,
		];
		expect(imageInfo(riff(vp8l), "image/webp")).toEqual({
			width: 320,
			height: 240,
			animated: false,
		});
		const vp8x = [...ascii("VP8X"), 10, 0, 0, 0, 0x02, 0, 0, 0, ...u24le(319), ...u24le(239), 0, 0];
		expect(imageInfo(riff(vp8x), "image/webp")).toEqual({
			width: 320,
			height: 240,
			animated: true,
		});
	});

	it("reads AVIF ispe and flags avis as animated", () => {
		const ftyp = (brand: string) => box("ftyp", [...ascii(brand), 0, 0, 0, 0, ...ascii("mif1")]);
		const ispe = box("ispe", [...u32be(1024), ...u32be(768)], true);
		const meta = box("meta", [box("iprp", [box("ipco", [box("colr", [0, 0, 0, 0]), ispe])])], true);
		expect(imageInfo(new Uint8Array([...ftyp("avif"), ...meta]), "image/avif")).toEqual({
			width: 1024,
			height: 768,
			animated: false,
		});
		expect(imageInfo(new Uint8Array([...ftyp("avis"), ...meta]), "image/avif")).toEqual({
			width: 1024,
			height: 768,
			animated: true,
		});
	});

	it("returns nulls for unparseable or unknown input", () => {
		expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toEqual({
			width: null,
			height: null,
			animated: false,
		});
		expect(imageInfo(new Uint8Array(64), "application/octet-stream")).toEqual({
			width: null,
			height: null,
			animated: false,
		});
	});
});
