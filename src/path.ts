import { CID_PATTERN } from "./cid.ts";

export type BlobPath =
	| { kind: "blob"; did: string; cid: string }
	| { kind: "redirect"; location: string }
	| { kind: "invalid" }
	| { kind: "unknown" };

const DID_PLC = /^did:plc:[a-z2-7]{24}$/;
// did:web: host (optionally with a percent-encoded port) followed by optional
// colon-separated path segments. Hosts are lowercased at canonicalisation.
const DID_WEB =
	/^did:web:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:%3a\d{1,5})?(?::[A-Za-z0-9._~-]+)*$/;
// A percent-encoded colon introducing a did:web port: "%3a" followed by digits
// then a segment boundary. Every other "%3a" is decoded like any escape.
const PORT_ESCAPE = /%3a(?=\d{1,5}(?::|$))/gi;
const CID_UPPER = /^B[A-Z2-7]+$/;

export function isValidDid(did: string): boolean {
	return DID_PLC.test(did) || DID_WEB.test(did);
}

function canonicalDid(did: string): string | undefined {
	if (DID_PLC.test(did)) return did;
	const lower = did.toLowerCase();
	if (!lower.startsWith("did:web:")) return undefined;
	// Method and host are case-insensitive; path segments keep their case.
	const [host, ...path] = did.slice("did:web:".length).split(":");
	const candidate = ["did:web:" + host!.toLowerCase(), ...path].join(":");
	return DID_WEB.test(candidate) ? candidate : undefined;
}

function canonicalCid(cid: string): string | undefined {
	if (CID_PATTERN.test(cid)) return cid;
	if (CID_UPPER.test(cid)) return cid.toLowerCase();
	return undefined;
}

/**
 * Classifies a request path. Exactly one path serves bytes for a blob; every
 * alias (trailing slash, percent-encoding, uppercase CID or did:web host)
 * redirects to it so the cache holds one entry per blob. "invalid" is a
 * two-segment path whose DID or CID is malformed; "unknown" is any other shape.
 */
export function parseBlobPath(pathname: string): BlobPath {
	const segments = pathname.split("/").filter((segment) => segment !== "");
	if (segments.length !== 2 || !/^did(:|%3a)/i.test(segments[0]!)) return { kind: "unknown" };
	let rawDid: string;
	let rawCid: string;
	try {
		rawDid = segments[0]!.split(PORT_ESCAPE).map(decodeURIComponent).join("%3a");
		rawCid = decodeURIComponent(segments[1]!);
	} catch {
		return { kind: "invalid" };
	}
	const did = canonicalDid(rawDid);
	const cid = canonicalCid(rawCid);
	if (did === undefined || cid === undefined) return { kind: "invalid" };
	const canonical = `/${did}/${cid}`;
	if (canonical !== pathname) return { kind: "redirect", location: canonical };
	return { kind: "blob", did, cid };
}
