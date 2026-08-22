/**
 * Minimal DAG-CBOR decoder, enough for ATProto event streams: unsigned and
 * negative integers, byte strings, text, arrays, maps with text keys, the
 * simple values, floats, and tag 42 (CID links, returned as `{ $link }`).
 * Indefinite-length items are not part of DAG-CBOR and are rejected.
 */
export interface CidLink {
	$link: Uint8Array;
}

export type CborValue =
	| number
	| bigint
	| string
	| boolean
	| null
	| undefined
	| Uint8Array
	| CidLink
	| CborValue[]
	| { [key: string]: CborValue };

export class CborError extends Error {}

class Decoder {
	private readonly view: DataView;
	offset = 0;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	get remaining(): number {
		return this.bytes.length - this.offset;
	}

	private need(n: number): void {
		if (this.offset + n > this.bytes.length) throw new CborError("Unexpected end of CBOR data");
	}

	private readLength(info: number): number {
		if (info < 24) return info;
		if (info === 24) {
			this.need(1);
			return this.bytes[this.offset++]!;
		}
		if (info === 25) {
			this.need(2);
			const value = this.view.getUint16(this.offset);
			this.offset += 2;
			return value;
		}
		if (info === 26) {
			this.need(4);
			const value = this.view.getUint32(this.offset);
			this.offset += 4;
			return value;
		}
		if (info === 27) {
			this.need(8);
			const value = this.view.getBigUint64(this.offset);
			this.offset += 8;
			if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("Integer too large");
			return Number(value);
		}
		throw new CborError(`Unsupported additional info ${info}`);
	}

	private readBytes(length: number): Uint8Array {
		this.need(length);
		const slice = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return slice;
	}

	decode(): CborValue {
		this.need(1);
		const initial = this.bytes[this.offset++]!;
		const major = initial >> 5;
		const info = initial & 0x1f;
		switch (major) {
			case 0:
				return this.readLength(info);
			case 1:
				return -1 - this.readLength(info);
			case 2:
				return this.readBytes(this.readLength(info));
			case 3:
				return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
					this.readBytes(this.readLength(info)),
				);
			case 4: {
				const length = this.readLength(info);
				const items: CborValue[] = [];
				for (let i = 0; i < length; i++) items.push(this.decode());
				return items;
			}
			case 5: {
				const length = this.readLength(info);
				const map: { [key: string]: CborValue } = {};
				for (let i = 0; i < length; i++) {
					const key = this.decode();
					if (typeof key !== "string") throw new CborError("Map keys must be strings");
					map[key] = this.decode();
				}
				return map;
			}
			case 6: {
				const tag = this.readLength(info);
				const value = this.decode();
				if (tag === 42) {
					if (!(value instanceof Uint8Array) || value[0] !== 0) {
						throw new CborError("Tag 42 must wrap a CID with a leading identity byte");
					}
					return { $link: value.subarray(1) };
				}
				throw new CborError(`Unsupported tag ${tag}`);
			}
			case 7:
				switch (info) {
					case 20:
						return false;
					case 21:
						return true;
					case 22:
						return null;
					case 23:
						return undefined;
					case 25: {
						this.need(2);
						const value = this.view.getFloat32(this.offset);
						this.offset += 2;
						return value;
					}
					case 26: {
						this.need(4);
						const value = this.view.getFloat32(this.offset);
						this.offset += 4;
						return value;
					}
					case 27: {
						this.need(8);
						const value = this.view.getFloat64(this.offset);
						this.offset += 8;
						return value;
					}
					default:
						throw new CborError(`Unsupported simple value ${info}`);
				}
			default:
				throw new CborError(`Unsupported major type ${major}`);
		}
	}
}

export function decodeCbor(bytes: Uint8Array): CborValue {
	const decoder = new Decoder(bytes);
	const value = decoder.decode();
	if (decoder.remaining !== 0) throw new CborError("Trailing bytes after CBOR item");
	return value;
}

/** Decodes every concatenated CBOR item in a buffer (event-stream frames). */
export function decodeCborSequence(bytes: Uint8Array): CborValue[] {
	const decoder = new Decoder(bytes);
	const items: CborValue[] = [];
	while (decoder.remaining > 0) items.push(decoder.decode());
	return items;
}
