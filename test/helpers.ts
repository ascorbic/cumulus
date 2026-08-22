import { encodeBlobCid } from "../src/cid.ts";

export const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
export const PDS = "https://pds.example.com";

export const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngBytes(size = 64): Uint8Array {
	const bytes = new Uint8Array(size);
	bytes.set(PNG_HEADER);
	for (let i = PNG_HEADER.length; i < size; i++) bytes[i] = (i * 31) & 0xff;
	return bytes;
}

export async function cidFor(bytes: Uint8Array): Promise<string> {
	return encodeBlobCid(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function didDocument(did = DID, pds: string = PDS): unknown {
	return {
		id: did,
		service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }],
	};
}

export type FetchStub = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Routes stubbed outbound fetches by hostname; unmatched hosts fail loudly. */
export function stubFetch(
	routes: Record<string, FetchStub>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const handler = routes[url.hostname];
		if (!handler) throw new Error(`Unexpected outbound fetch: ${url.href}`);
		return handler(url, init);
	};
}
