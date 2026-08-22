import { loadConfig } from "./config.ts";
import { recordTag, purgeTags as purgeDefault } from "./response.ts";
import { readSocket, type SocketOptions } from "./socket.ts";
import { keys, type DrainStatus } from "./store.ts";

export const JETSTREAM = "jetstream";

export interface JetstreamOptions extends Partial<SocketOptions> {
	purge?: (tags: string[]) => Promise<boolean>;
}

interface Commit {
	operation: "create" | "update" | "delete";
	collection: string;
	rkey: string;
}

interface JetstreamEvent {
	did: string;
	time_us: number;
	commit?: Commit;
}

const BATCH = 100;
const PURGE_TAG_LIMIT = 100;

/** `app.example.*` matches any collection under that prefix; otherwise exact. */
export function collectionMatches(collection: string, patterns: string[]): boolean {
	return patterns.some((pattern) =>
		pattern.endsWith(".*")
			? collection === pattern.slice(0, -2) || collection.startsWith(pattern.slice(0, -1))
			: collection === pattern,
	);
}

/** Every event carries `time_us` (the cursor); only `commit` events carry work. */
function parseEvent(frame: unknown): JetstreamEvent | undefined {
	if (typeof frame !== "string") return undefined;
	let event: { did?: unknown; time_us?: unknown; kind?: unknown; commit?: Partial<Commit> };
	try {
		event = JSON.parse(frame) as typeof event;
	} catch {
		return undefined;
	}
	if (typeof event.did !== "string" || typeof event.time_us !== "number") return undefined;
	const commit = event.commit;
	const parsed: JetstreamEvent = { did: event.did, time_us: event.time_us };
	if (
		event.kind === "commit" &&
		commit &&
		typeof commit.collection === "string" &&
		typeof commit.rkey === "string" &&
		(commit.operation === "create" ||
			commit.operation === "update" ||
			commit.operation === "delete")
	) {
		parsed.commit = {
			operation: commit.operation,
			collection: commit.collection,
			rkey: commit.rkey,
		};
	}
	return parsed;
}

export function jetstreamUrl(base: string, collections: string[], cursor: number | null): string {
	const url = new URL(`${base}/subscribe`);
	for (const collection of collections) url.searchParams.append("wantedCollections", collection);
	if (cursor !== null) url.searchParams.set("cursor", String(cursor));
	return url.href;
}

/**
 * The scoped-mode half of the cron: record deletes and updates in the
 * allowlisted collections become `rec:` tag purges, so the cache's tag store
 * is the backlink index.
 */
export async function drainJetstream(
	env: Env,
	ctx: ExecutionContext,
	options: JetstreamOptions = {},
): Promise<DrainStatus | undefined> {
	const config = loadConfig(env);
	if (config.mode !== "scoped" || !config.jetstreamUrl) return undefined;
	const socket: SocketOptions = {
		budgetMs: options.budgetMs ?? 20_000,
		idleMs: options.idleMs ?? 2_000,
		now: options.now ?? Date.now,
	};
	const purge =
		options.purge ??
		(async (tags: string[]) => {
			const results = await Promise.all([
				purgeDefault(ctx, tags),
				ctx.exports.Record.purgeTags(tags),
			]);
			return results.every((result) => result.success);
		});
	const stored = await env.LABELS_KV.get(keys.cursor(JETSTREAM));
	const cursor = stored === null ? null : Number(stored);
	const status: DrainStatus = {
		lastDrain: new Date(socket.now()).toISOString(),
		seq: Number.isSafeInteger(cursor) ? cursor : null,
		events: 0,
		purged: 0,
	};
	let pending = new Set<string>();
	let seq = status.seq ?? 0;
	const flush = async () => {
		const tags = [...pending];
		for (let i = 0; i < tags.length; i += PURGE_TAG_LIMIT) {
			const chunk = tags.slice(i, i + PURGE_TAG_LIMIT);
			if (await purge(chunk)) status.purged += chunk.length;
			else
				console.error(
					JSON.stringify({ event: "purge-failed", source: JETSTREAM, tags: chunk.length }),
				);
		}
		pending = new Set();
		await env.LABELS_KV.put(keys.cursor(JETSTREAM), String(seq));
	};
	try {
		const url = jetstreamUrl(config.jetstreamUrl, config.scopedCollections, status.seq);
		for await (const frame of readSocket(url, socket)) {
			const event = parseEvent(frame);
			if (!event) continue;
			seq = event.time_us;
			if (!event.commit || event.commit.operation === "create") continue;
			if (!collectionMatches(event.commit.collection, config.scopedCollections)) continue;
			status.events++;
			pending.add(recordTag(event.did, event.commit.collection, event.commit.rkey));
			if (pending.size >= BATCH) await flush();
		}
		if (pending.size > 0 || seq !== status.seq) await flush();
		status.seq = seq;
	} catch (error) {
		status.error = (error as Error).message;
		console.error(
			JSON.stringify({ event: "drain-failed", source: JETSTREAM, detail: status.error }),
		);
	}
	await env.LABELS_KV.put(keys.status(JETSTREAM), JSON.stringify(status));
	return status;
}
