import { describe, expect, it } from "vitest";
import { sniff, sniffMime } from "../src/sniff.ts";
import { pngBytes } from "./helpers.ts";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function ftyp(major: string, compatible: string[] = []): Uint8Array {
	const size = 16 + compatible.length * 4;
	const bytes = new Uint8Array(size + 8);
	bytes.set([0, 0, 0, size]);
	bytes.set(ascii("ftyp"), 4);
	bytes.set(ascii(major), 8);
	compatible.forEach((brand, i) => bytes.set(ascii(brand), 16 + i * 4));
	return bytes;
}

describe("sniffMime", () => {
	it("detects the allowlisted image formats", () => {
		expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
		expect(sniffMime(pngBytes())).toBe("image/png");
		expect(sniffMime(new Uint8Array(ascii("GIF89a\0\0")))).toBe("image/gif");
		expect(sniffMime(new Uint8Array(ascii("GIF87a\0\0")))).toBe("image/gif");
		expect(sniffMime(new Uint8Array([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBPVP8 ")]))).toBe(
			"image/webp",
		);
		expect(sniffMime(ftyp("avif"))).toBe("image/avif");
		expect(sniffMime(ftyp("avis"))).toBe("image/avif");
		expect(sniffMime(ftyp("mif1", ["miaf", "avif"]))).toBe("image/avif");
	});

	it("falls back to octet-stream", () => {
		expect(sniffMime(new Uint8Array(ascii("<svg xmlns=")))).toBe("application/octet-stream");
		expect(sniffMime(ftyp("heic", ["mif1"]))).toBe("application/octet-stream");
		expect(sniffMime(ftyp("isom", ["mp41"]))).toBe("application/octet-stream");
		expect(sniffMime(new Uint8Array([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")]))).toBe(
			"application/octet-stream",
		);
		expect(sniffMime(new Uint8Array(0))).toBe("application/octet-stream");
		expect(sniffMime(new Uint8Array([0xff, 0xd8]))).toBe("application/octet-stream");
	});

	it("maps extensions", () => {
		expect(sniff(pngBytes())).toEqual({ mime: "image/png", ext: "png" });
		expect(sniff(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual({ mime: "image/jpeg", ext: "jpg" });
		expect(sniff(new Uint8Array(3))).toEqual({ mime: "application/octet-stream", ext: "bin" });
	});
});
