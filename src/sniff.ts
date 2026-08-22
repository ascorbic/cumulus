export interface SniffedType {
	mime: string;
	ext: string;
}

export const EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"application/octet-stream": "bin",
};

const ASCII = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87 = ASCII("GIF87a");
const GIF89 = ASCII("GIF89a");
const RIFF = ASCII("RIFF");
const WEBP = ASCII("WEBP");
const FTYP = ASCII("ftyp");
const AVIF_BRANDS = new Set(["avif", "avis"]);

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
	if (bytes.length < offset + signature.length) return false;
	for (let i = 0; i < signature.length; i++) {
		if (bytes[offset + i] !== signature[i]) return false;
	}
	return true;
}

function isAvif(bytes: Uint8Array): boolean {
	if (bytes.length < 16 || !startsWith(bytes, FTYP, 4)) return false;
	const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
	const end = Math.min(bytes.length, boxSize === 0 ? bytes.length : boxSize);
	const decoder = new TextDecoder("ascii");
	// Major brand at 8, minor version at 12, compatible brands from 16.
	if (AVIF_BRANDS.has(decoder.decode(bytes.subarray(8, 12)))) return true;
	for (let offset = 16; offset + 4 <= end; offset += 4) {
		if (AVIF_BRANDS.has(decoder.decode(bytes.subarray(offset, offset + 4)))) return true;
	}
	return false;
}

export function sniffMime(bytes: Uint8Array): string {
	if (startsWith(bytes, JPEG)) return "image/jpeg";
	if (startsWith(bytes, PNG)) return "image/png";
	if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "image/gif";
	if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
	if (isAvif(bytes)) return "image/avif";
	return "application/octet-stream";
}

export function sniff(bytes: Uint8Array): SniffedType {
	const mime = sniffMime(bytes);
	return { mime, ext: EXTENSIONS[mime] ?? "bin" };
}
