export interface Label {
	src: string;
	uri: string;
	cid?: string;
	val: string;
	neg?: boolean;
	cts: string;
	exp?: string;
}

export interface LabelerConfig {
	did: string;
	vals: string[];
}

export const LABELER_TIMEOUT_MS = 5000;

export class LabelerOutage extends Error {}

export function parseLabelers(json: string): LabelerConfig[] {
	if (!json.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("LABELERS is not valid JSON");
	}
	if (!Array.isArray(parsed)) throw new Error("LABELERS must be a JSON array");
	return parsed.map((entry: unknown, index) => {
		const { did, vals } = (entry ?? {}) as { did?: unknown; vals?: unknown };
		if (typeof did !== "string" || !did.startsWith("did:")) {
			throw new Error(`LABELERS[${index}].did must be a DID`);
		}
		if (!Array.isArray(vals) || vals.length === 0 || !vals.every((v) => typeof v === "string")) {
			throw new Error(`LABELERS[${index}].vals must be a non-empty array of label values`);
		}
		return { did, vals: vals as string[] };
	});
}

export function isLabel(value: unknown): value is Label {
	if (typeof value !== "object" || value === null) return false;
	const label = value as Record<string, unknown>;
	return (
		typeof label.src === "string" &&
		typeof label.uri === "string" &&
		typeof label.val === "string" &&
		typeof label.cts === "string" &&
		(label.cid === undefined || typeof label.cid === "string") &&
		(label.neg === undefined || typeof label.neg === "boolean") &&
		(label.exp === undefined || typeof label.exp === "string")
	);
}

/** A label currently in force from this labeler with one of its enforced values. */
export function isEnforced(label: Label, labeler: LabelerConfig, now: number): boolean {
	if (label.src !== labeler.did || !labeler.vals.includes(label.val)) return false;
	if (label.neg) return false;
	if (label.exp !== undefined) {
		const expires = Date.parse(label.exp);
		if (!Number.isNaN(expires) && expires <= now) return false;
	}
	return true;
}

export function isAccountLabel(label: Label): boolean {
	return label.uri.startsWith("did:");
}

export interface RecordUri {
	did: string;
	collection: string;
	rkey: string;
}

export function parseRecordUri(uri: string): RecordUri | undefined {
	const match =
		/^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/([A-Za-z0-9.-]+)\/([A-Za-z0-9._:~-]+)$/.exec(uri);
	if (!match) return undefined;
	return { did: match[1]!, collection: match[2]!, rkey: match[3]! };
}

export function queryLabelsUrl(endpoint: string, did: string, labelerDid: string): string {
	const url = new URL(`${endpoint}/xrpc/com.atproto.label.queryLabels`);
	url.searchParams.set("uriPatterns", did);
	url.searchParams.set("sources", labelerDid);
	url.searchParams.set("limit", "250");
	return url.href;
}

/** Account-level labels a labeler currently holds for a DID. */
export async function queryLabels(
	endpoint: string,
	did: string,
	labelerDid: string,
): Promise<Label[]> {
	let response: Response;
	try {
		response = await fetch(queryLabelsUrl(endpoint, did, labelerDid), {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(LABELER_TIMEOUT_MS),
		});
	} catch (error) {
		throw new LabelerOutage(`Labeler ${labelerDid} unreachable: ${String(error)}`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new LabelerOutage(`Labeler ${labelerDid} returned ${response.status}`);
	}
	let body: { labels?: unknown };
	try {
		body = (await response.json()) as { labels?: unknown };
	} catch {
		throw new LabelerOutage(`Labeler ${labelerDid} returned malformed JSON`);
	}
	if (!Array.isArray(body.labels))
		throw new LabelerOutage(`Labeler ${labelerDid} returned no labels array`);
	return body.labels.filter(isLabel);
}

/** Collects the blob CIDs a record references (`{ $type: "blob", ref: { $link } }`). */
export function blobRefs(record: unknown, found = new Set<string>()): Set<string> {
	if (Array.isArray(record)) {
		for (const item of record) blobRefs(item, found);
		return found;
	}
	if (typeof record !== "object" || record === null) return found;
	const object = record as Record<string, unknown>;
	if (object.$type === "blob" && typeof object.ref === "object" && object.ref !== null) {
		const link = (object.ref as { $link?: unknown }).$link;
		if (typeof link === "string") found.add(link);
		return found;
	}
	for (const value of Object.values(object)) blobRefs(value, found);
	return found;
}
