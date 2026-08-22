export interface ImageInfo {
	width: number | null;
	height: number | null;
	animated: boolean;
}

const UNKNOWN: ImageInfo = { width: null, height: null, animated: false };

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) =>
	((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function jpeg(b: Uint8Array): ImageInfo {
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return UNKNOWN;
		const marker = b[i + 1]!;
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			i += 2;
			continue;
		}
		const isSof =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			return { height: u16be(b, i + 5), width: u16be(b, i + 7), animated: false };
		}
		i += 2 + u16be(b, i + 2);
	}
	return UNKNOWN;
}

function png(b: Uint8Array): ImageInfo {
	if (b.length < 24) return UNKNOWN;
	const info: ImageInfo = { width: u32be(b, 16), height: u32be(b, 20), animated: false };
	let i = 8;
	while (i + 8 <= b.length) {
		const length = u32be(b, i);
		const type = ascii(b, i + 4, 4);
		if (type === "acTL") info.animated = true;
		if (type === "IDAT" || type === "IEND") break;
		i += 12 + length;
	}
	return info;
}

function gifSubBlocks(b: Uint8Array, i: number): number {
	while (i < b.length) {
		const size = b[i]!;
		i += 1 + size;
		if (size === 0) break;
	}
	return i;
}

function gif(b: Uint8Array): ImageInfo {
	if (b.length < 13) return UNKNOWN;
	const info: ImageInfo = { width: u16le(b, 6), height: u16le(b, 8), animated: false };
	let i = 13;
	const flags = b[10]!;
	if (flags & 0x80) i += 3 << ((flags & 0x07) + 1);
	let frames = 0;
	while (i < b.length && frames < 2) {
		const block = b[i]!;
		if (block === 0x2c) {
			frames++;
			const localFlags = b[i + 9] ?? 0;
			i += 10;
			if (localFlags & 0x80) i += 3 << ((localFlags & 0x07) + 1);
			i = gifSubBlocks(b, i + 1);
		} else if (block === 0x21) {
			i = gifSubBlocks(b, i + 2);
		} else {
			break;
		}
	}
	info.animated = frames > 1;
	return info;
}

function webp(b: Uint8Array): ImageInfo {
	if (b.length < 16) return UNKNOWN;
	const chunk = ascii(b, 12, 4);
	if (chunk === "VP8 " && b.length >= 30) {
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return UNKNOWN;
		return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, animated: false };
	}
	if (chunk === "VP8L" && b.length >= 25) {
		if (b[20] !== 0x2f) return UNKNOWN;
		const bits = u32be(new Uint8Array([b[24]!, b[23]!, b[22]!, b[21]!]), 0);
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
	}
	if (chunk === "VP8X" && b.length >= 30) {
		return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, animated: (b[20]! & 0x02) !== 0 };
	}
	return UNKNOWN;
}

function findBox(
	b: Uint8Array,
	start: number,
	end: number,
	type: string,
	fullBox = false,
): [number, number] | undefined {
	let i = start;
	while (i + 8 <= end) {
		let size = u32be(b, i);
		let header = 8;
		if (size === 1) {
			if (i + 16 > end) return undefined;
			size = u32be(b, i + 12) + u32be(b, i + 8) * 2 ** 32;
			header = 16;
		} else if (size === 0) {
			size = end - i;
		}
		if (size < header) return undefined;
		if (ascii(b, i + 4, 4) === type) {
			return [i + header + (fullBox ? 4 : 0), Math.min(end, i + size)];
		}
		i += size;
	}
	return undefined;
}

function avif(b: Uint8Array): ImageInfo {
	const animated = b.length >= 12 && ascii(b, 8, 4) === "avis";
	const meta = findBox(b, 0, b.length, "meta", true);
	if (!meta) return { ...UNKNOWN, animated };
	const iprp = findBox(b, meta[0], meta[1], "iprp");
	if (!iprp) return { ...UNKNOWN, animated };
	const ipco = findBox(b, iprp[0], iprp[1], "ipco");
	if (!ipco) return { ...UNKNOWN, animated };
	const ispe = findBox(b, ipco[0], ipco[1], "ispe", true);
	if (!ispe || ispe[0] + 8 > ispe[1]) return { ...UNKNOWN, animated };
	return { width: u32be(b, ispe[0]), height: u32be(b, ispe[0] + 4), animated };
}

const PARSERS: Record<string, (bytes: Uint8Array) => ImageInfo> = {
	"image/jpeg": jpeg,
	"image/png": png,
	"image/gif": gif,
	"image/webp": webp,
	"image/avif": avif,
};

/** Reads dimensions and an animation flag from a sniffed image's headers. */
export function imageInfo(bytes: Uint8Array, mime: string): ImageInfo {
	const parse = PARSERS[mime];
	if (!parse) return UNKNOWN;
	try {
		return parse(bytes);
	} catch {
		return UNKNOWN;
	}
}
