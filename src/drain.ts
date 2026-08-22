import { decodeCborSequence, type CborValue } from "./cbor.ts";
import { loadConfig } from "./config.ts";
import { labelerEndpoint } from "./entrypoints/policy.ts";
import {
	blobRefs,
	isAccountLabel,
	isLabel,
	parseRecordUri,
	type Label,
	type LabelerConfig,
} from "./labels.ts";
import { cidTag, didTag, purgeTags as purgeDefault } from "./response.ts";
import {
	clearRecordDenials,
	readCursor,
	writeCursor,
	writeRecordDenials,
	writeStatus,
	type DrainStatus,
} from "./store.ts";

export interface DrainOptions {
	/** Stop reading a labeler's stream after this long. */
	budgetMs?: number;
	/** Treat the stream as caught up after this long without a frame. */
	idleMs?: number;
	/** Purge tags on default + Policy; overridable for tests. */
	purge?: (tags: string[]) => Promise<boolean>;
	now?: () => number;
}

export interface DrainResult {
	labeler: string;
	status: DrainStatus;
}

const BATCH = 100;
const PURGE_TAG_LIMIT = 100;

interface Frame {
	seq: number;
	labels: Label[];
}

async function parseFrame(
	data: ArrayBuffer | Blob | string,
): Promise<Frame | { info: string } | { error: string } | undefined> {
	if (typeof data === "string") return undefined;
	const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
	const [header, body] = decodeCborSequence(bytes) as Array<
		{ [key: string]: CborValue } | undefined
	>;
	if (!header || typeof header !== "object") return undefined;
	if (header.op === -1) {
		const error = body && typeof body === "object" ? body.error : undefined;
		return { error: typeof error === "string" ? error : "unknown" };
	}
	if (header.t === "#info" && body && typeof body === "object") {
		return { info: typeof body.name === "string" ? body.name : "info" };
	}
	if (header.t !== "#labels" || !body || typeof body !== "object") return undefined;
	const seq = body.seq;
	if (typeof seq !== "number" || !Array.isArray(body.labels)) return undefined;
	return { seq, labels: (body.labels as unknown[]).filter(isLabel) };
}

/**
 * Opens `subscribeLabels` and yields frames until the stream goes idle or the
 * budget elapses. Outbound websockets cannot hibernate, so the socket lives
 * only for the drain.
 */
export async function* readStream(
	endpoint: string,
	cursor: number | null,
	{ budgetMs, idleMs, now }: Required<Pick<DrainOptions, "budgetMs" | "idleMs" | "now">>,
): AsyncGenerator<Frame> {
	const url = new URL(`${endpoint}/xrpc/com.atproto.label.subscribeLabels`);
	if (cursor !== null) url.searchParams.set("cursor", String(cursor));
	const response = await fetch(url.href, { headers: { upgrade: "websocket" } });
	const socket = response.webSocket;
	if (!socket) {
		await response.body?.cancel();
		throw new Error(`subscribeLabels upgrade failed with ${response.status}`);
	}
	const queue: Array<ArrayBuffer | Blob | string> = [];
	let wake: (() => void) | undefined;
	let closed = false;
	const signal = () => {
		wake?.();
		wake = undefined;
	};
	socket.addEventListener("message", (event) => {
		queue.push(event.data as ArrayBuffer | Blob | string);
		signal();
	});
	socket.addEventListener("close", () => {
		closed = true;
		signal();
	});
	socket.addEventListener("error", () => {
		closed = true;
		signal();
	});
	socket.accept();

	const deadline = now() + budgetMs;
	try {
		for (;;) {
			while (queue.length > 0) {
				const frame = await parseFrame(queue.shift()!);
				if (!frame) continue;
				if ("error" in frame) throw new Error(`subscribeLabels error: ${frame.error}`);
				if ("info" in frame) {
					console.warn(JSON.stringify({ event: "labels-info", endpoint, name: frame.info }));
					continue;
				}
				yield frame;
			}
			if (closed) return;
			const wait = Math.min(idleMs, deadline - now());
			if (wait <= 0) return;
			const woke = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), wait);
				wake = () => {
					clearTimeout(timer);
					resolve(true);
				};
			});
			if (!woke && queue.length === 0) return;
		}
	} finally {
		try {
			socket.close(1000, "drain complete");
		} catch {
			// Already closed by the peer.
		}
	}
}

interface Work {
	tags: Set<string>;
	seq: number;
	events: number;
}

async function enrichRecord(
	env: Env,
	ctx: ExecutionContext,
	label: Label,
	uri: { did: string; collection: string; rkey: string },
	work: Work,
): Promise<void> {
	work.tags.add(didTag(uri.did));
	if (label.neg) {
		for (const cid of await clearRecordDenials(env.LABELS_KV, uri.did, label.uri)) {
			work.tags.add(cidTag(cid));
		}
		return;
	}
	const identity = await ctx.exports.Identity.fetch(`http://identity/did/${uri.did}`);
	let cids: Iterable<string> = label.cid ? [label.cid] : [];
	if (identity.ok) {
		const { pds } = (await identity.json()) as { pds: string };
		const recordUrl = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
		recordUrl.searchParams.set("repo", uri.did);
		recordUrl.searchParams.set("collection", uri.collection);
		recordUrl.searchParams.set("rkey", uri.rkey);
		const response = await fetch(recordUrl.href, { signal: AbortSignal.timeout(10_000) });
		if (response.ok) {
			const { value } = (await response.json()) as { value?: unknown };
			cids = blobRefs(value);
		} else {
			await response.body?.cancel();
			console.warn(
				JSON.stringify({
					event: "record-label-unresolved",
					uri: label.uri,
					status: response.status,
				}),
			);
		}
	} else {
		await identity.body?.cancel();
	}
	const written = await writeRecordDenials(env.LABELS_KV, uri.did, label.uri, cids, {
		uri: label.uri,
		src: label.src,
		val: label.val,
		cts: label.cts,
	});
	for (const cid of written) work.tags.add(cidTag(cid));
}

async function flush(
	env: Env,
	labeler: LabelerConfig,
	work: Work,
	purge: (tags: string[]) => Promise<boolean>,
): Promise<number> {
	const tags = [...work.tags];
	let purged = 0;
	for (let i = 0; i < tags.length; i += PURGE_TAG_LIMIT) {
		const chunk = tags.slice(i, i + PURGE_TAG_LIMIT);
		if (await purge(chunk)) purged += chunk.length;
		else
			console.error(
				JSON.stringify({ event: "purge-failed", labeler: labeler.did, tags: chunk.length }),
			);
	}
	await writeCursor(env.LABELS_KV, labeler.did, work.seq);
	work.tags.clear();
	work.events = 0;
	return purged;
}

async function drainLabeler(
	env: Env,
	ctx: ExecutionContext,
	labeler: LabelerConfig,
	options: Required<DrainOptions>,
): Promise<DrainStatus> {
	const status: DrainStatus = {
		lastDrain: new Date(options.now()).toISOString(),
		seq: await readCursor(env.LABELS_KV, labeler.did),
		events: 0,
		purged: 0,
	};
	const endpoint = await labelerEndpoint(ctx, labeler.did);
	const work: Work = { tags: new Set(), seq: status.seq ?? 0, events: 0 };
	for await (const frame of readStream(endpoint, status.seq, options)) {
		work.seq = frame.seq;
		for (const label of frame.labels) {
			if (label.src !== labeler.did || !labeler.vals.includes(label.val)) continue;
			status.events++;
			work.events++;
			if (isAccountLabel(label)) {
				work.tags.add(didTag(label.uri));
			} else {
				const uri = parseRecordUri(label.uri);
				if (uri) await enrichRecord(env, ctx, label, uri, work);
			}
		}
		if (work.events >= BATCH) status.purged += await flush(env, labeler, work, options.purge);
	}
	if (work.events > 0 || work.seq !== status.seq)
		status.purged += await flush(env, labeler, work, options.purge);
	status.seq = work.seq;
	return status;
}

/** The cron body: one pass over every configured labeler's label stream. */
export async function drain(
	env: Env,
	ctx: ExecutionContext,
	options: DrainOptions = {},
): Promise<DrainResult[]> {
	const resolved: Required<DrainOptions> = {
		budgetMs: options.budgetMs ?? 20_000,
		idleMs: options.idleMs ?? 2_000,
		now: options.now ?? Date.now,
		purge:
			options.purge ??
			(async (tags) => {
				const results = await Promise.all([
					purgeDefault(ctx, tags),
					ctx.exports.Policy.purgeTags(tags),
				]);
				return results.every((result) => result.success);
			}),
	};
	const results: DrainResult[] = [];
	for (const labeler of loadConfig(env).labelers) {
		let status: DrainStatus;
		try {
			status = await drainLabeler(env, ctx, labeler, resolved);
		} catch (error) {
			status = {
				lastDrain: new Date(resolved.now()).toISOString(),
				seq: await readCursor(env.LABELS_KV, labeler.did),
				events: 0,
				purged: 0,
				error: (error as Error).message,
			};
			console.error(
				JSON.stringify({ event: "drain-failed", labeler: labeler.did, detail: status.error }),
			);
		}
		await writeStatus(env.LABELS_KV, labeler.did, status);
		results.push({ labeler: labeler.did, status });
	}
	return results;
}
