/**
 * KV holds exactly two kinds of state (SPEC.md §7a): per-labeler drain
 * cursors (plus a status record beside each) and the record-level deny set.
 */
export interface DenyEntry {
	uri: string;
	src: string;
	val: string;
	cts: string;
}

export interface DrainStatus {
	lastDrain: string;
	seq: number | null;
	events: number;
	purged: number;
	error?: string;
}

export const keys = {
	cursor: (labelerDid: string) => `cursor:${labelerDid}`,
	status: (labelerDid: string) => `status:${labelerDid}`,
	deny: (did: string, cid: string) => `deny:${did.toLowerCase()}/${cid.toLowerCase()}`,
	record: (uri: string) => `rec:${uri}`,
};

export async function readCursor(kv: KVNamespace, labelerDid: string): Promise<number | null> {
	const value = await kv.get(keys.cursor(labelerDid));
	if (value === null) return null;
	const seq = Number(value);
	return Number.isSafeInteger(seq) ? seq : null;
}

export function writeCursor(kv: KVNamespace, labelerDid: string, seq: number): Promise<void> {
	return kv.put(keys.cursor(labelerDid), String(seq));
}

export function readStatus(kv: KVNamespace, labelerDid: string): Promise<DrainStatus | null> {
	return kv.get<DrainStatus>(keys.status(labelerDid), "json");
}

export function writeStatus(
	kv: KVNamespace,
	labelerDid: string,
	status: DrainStatus,
): Promise<void> {
	return kv.put(keys.status(labelerDid), JSON.stringify(status));
}

export function readDeny(kv: KVNamespace, did: string, cid: string): Promise<DenyEntry | null> {
	return kv.get<DenyEntry>(keys.deny(did, cid), "json");
}

/** Records a record-level denial for each blob the record references. */
export async function writeRecordDenials(
	kv: KVNamespace,
	did: string,
	uri: string,
	cids: Iterable<string>,
	entry: DenyEntry,
): Promise<string[]> {
	const list = [...new Set([...cids].map((cid) => cid.toLowerCase()))];
	await Promise.all(list.map((cid) => kv.put(keys.deny(did, cid), JSON.stringify(entry))));
	await kv.put(keys.record(uri), JSON.stringify(list));
	return list;
}

/** Removes a record's denials (negation) and returns the CIDs that were cleared. */
export async function clearRecordDenials(
	kv: KVNamespace,
	did: string,
	uri: string,
): Promise<string[]> {
	const list = (await kv.get<string[]>(keys.record(uri), "json")) ?? [];
	await Promise.all(list.map((cid) => kv.delete(keys.deny(did, cid))));
	await kv.delete(keys.record(uri));
	return list;
}
