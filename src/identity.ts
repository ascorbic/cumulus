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

const SERVICES = {
	pds: { fragment: "#atproto_pds", type: "AtprotoPersonalDataServer" },
	labeler: { fragment: "#atproto_labeler", type: "AtprotoLabeler" },
} as const;

export type ServiceKind = keyof typeof SERVICES;

export function serviceFromDidDocument(
	did: string,
	doc: unknown,
	kind: ServiceKind,
): string | undefined {
	if (typeof doc !== "object" || doc === null) return undefined;
	const { id, service } = doc as DidDocument;
	if (id !== did || !Array.isArray(service)) return undefined;
	const { fragment, type } = SERVICES[kind];
	const entry = (service as Service[]).find(
		(candidate) =>
			typeof candidate === "object" &&
			candidate !== null &&
			(candidate.id === fragment || candidate.id === `${did}${fragment}`) &&
			candidate.type === type,
	);
	if (!entry || typeof entry.serviceEndpoint !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(entry.serviceEndpoint);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || !isPublicHostname(url.hostname)) return undefined;
	if (url.username || url.password || url.search || url.hash) return undefined;
	return url.origin + url.pathname.replace(/\/+$/, "");
}

export function pdsFromDidDocument(did: string, doc: unknown): string | undefined {
	return serviceFromDidDocument(did, doc, "pds");
}

/**
 * Resolves a DID to one of its service endpoints. Returns undefined when the
 * DID does not exist or its document declares no usable service of that
 * kind; throws IdentityError when the directory itself fails.
 */
export async function resolveService(
	did: string,
	kind: ServiceKind,
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
			redirect: "manual",
		});
	} catch (error) {
		throw new IdentityError(`DID resolution failed: ${String(error)}`);
	}
	if (response.status === 404 || response.status === 410) return undefined;
	// A DID document must live at its well-known URL; following a redirect
	// would let a did:web host point resolution anywhere.
	if (response.status >= 300 && response.status < 400) return undefined;
	if (!response.ok) throw new IdentityError(`DID resolution returned ${response.status}`);
	let doc: unknown;
	try {
		doc = await response.json();
	} catch {
		return undefined;
	}
	return serviceFromDidDocument(did, doc, kind);
}

export function resolvePds(
	did: string,
	options: { plcUrl: string; timeoutMs: number },
): Promise<string | undefined> {
	return resolveService(did, "pds", options);
}
