/** Tiny CBOR encoder for building subscribeLabels frames in tests. */
export type Encodable =
	| number
	| string
	| boolean
	| null
	| Uint8Array
	| Encodable[]
	| { [key: string]: Encodable };

function head(major: number, length: number): number[] {
	if (length < 24) return [(major << 5) | length];
	if (length < 0x100) return [(major << 5) | 24, length];
	if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
	return [
		(major << 5) | 26,
		(length >>> 24) & 0xff,
		(length >> 16) & 0xff,
		(length >> 8) & 0xff,
		length & 0xff,
	];
}

export function encodeCbor(value: Encodable): number[] {
	if (value === null) return [0xf6];
	if (value === true) return [0xf5];
	if (value === false) return [0xf4];
	if (typeof value === "number") {
		if (!Number.isInteger(value)) throw new Error("floats not supported");
		return value >= 0 ? head(0, value) : head(1, -1 - value);
	}
	if (typeof value === "string") {
		const bytes = new TextEncoder().encode(value);
		return [...head(3, bytes.length), ...bytes];
	}
	if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
	if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(encodeCbor)];
	const entries = Object.entries(value);
	return [
		...head(5, entries.length),
		...entries.flatMap(([k, v]) => [...encodeCbor(k), ...encodeCbor(v)]),
	];
}

export function labelsFrame(seq: number, labels: Encodable[]): Uint8Array {
	return new Uint8Array([...encodeCbor({ op: 1, t: "#labels" }), ...encodeCbor({ seq, labels })]);
}

export function infoFrame(name: string): Uint8Array {
	return new Uint8Array([...encodeCbor({ op: 1, t: "#info" }), ...encodeCbor({ name })]);
}

export function errorFrame(error: string): Uint8Array {
	return new Uint8Array([...encodeCbor({ op: -1 }), ...encodeCbor({ error })]);
}
