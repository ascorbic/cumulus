export class IdentityError extends Error {}

interface DidDocument {
	id?: unknown;
	service?: unknown;
}

interface Service {
	id?: unknown;
	type?: unknown;
	serviceEndpoint?: unknown;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isPublicHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return false;
	if (host.startsWith("[") || host.includes(":")) return false;
	if (IPV4.test(host)) return false;
	if (!host.includes(".")) return false;
	if (/\.(local|internal|localdomain|home|lan|arpa)$/.test(host)) return false;
	return true;
}

export function didDocumentUrl(did: string, plcUrl: string): string {
	if (did.startsWith("did:plc:")) return `${plcUrl}/${did}`;
	const [host, ...path] = did.slice("did:web:".length).split(":");
	const origin = `https://${host!.replace(/%3a/i, ":")}`;
	if (path.length === 0) return `${origin}/.well-known/did.json`;
	return `${origin}/${path.map(encodeURIComponent).join("/")}/did.json`;
}

export function pdsFromDidDocument(did: string, doc: unknown): string | undefined {
	if (typeof doc !== "object" || doc === null) return undefined;
	const { id, service } = doc as DidDocument;
	if (id !== did || !Array.isArray(service)) return undefined;
	const pds = (service as Service[]).find(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			(entry.id === "#atproto_pds" || entry.id === `${did}#atproto_pds`) &&
			entry.type === "AtprotoPersonalDataServer",
	);
	if (!pds || typeof pds.serviceEndpoint !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(pds.serviceEndpoint);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || !isPublicHostname(url.hostname)) return undefined;
	if (url.username || url.password || url.search || url.hash) return undefined;
	return url.origin + url.pathname.replace(/\/+$/, "");
}

/**
 * Resolves a DID to its PDS origin. Returns undefined when the DID does not
 * exist or its document declares no usable PDS; throws IdentityError when the
 * directory itself fails.
 */
export async function resolvePds(
	did: string,
	options: { plcUrl: string; timeoutMs: number },
): Promise<string | undefined> {
	if (did.startsWith("did:web:")) {
		const host = did
			.slice("did:web:".length)
			.split(":")[0]!
			.replace(/%3a.*$/i, "");
		if (!isPublicHostname(host)) return undefined;
	}
	let response: Response;
	try {
		response = await fetch(didDocumentUrl(did, options.plcUrl), {
			headers: { accept: "application/did+ld+json, application/json" },
			signal: AbortSignal.timeout(options.timeoutMs),
			redirect: "error",
		});
	} catch (error) {
		throw new IdentityError(`DID resolution failed: ${String(error)}`);
	}
	if (response.status === 404 || response.status === 410) return undefined;
	if (!response.ok) throw new IdentityError(`DID resolution returned ${response.status}`);
	let doc: unknown;
	try {
		doc = await response.json();
	} catch {
		return undefined;
	}
	return pdsFromDidDocument(did, doc);
}
