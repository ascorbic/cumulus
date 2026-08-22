import { CID_PATTERN } from "./cid.ts";
import type { Config } from "./config.ts";
import { isValidCollection, isValidRkey, type RecordInfo } from "./entrypoints/record.ts";
import { collectionMatches } from "./jetstream.ts";
import { parseBlobPath } from "./path.ts";
import { CACHE_CONTROL, blobTags, errorResponse, recordTag, versionTag } from "./response.ts";

export interface ScopedRef {
	did: string;
	collection: string;
	rkey: string;
	cid: string;
}

export type ScopedPath =
	| ({ kind: "scoped" } & ScopedRef)
	| { kind: "redirect"; location: string }
	| { kind: "invalid" }
	| { kind: "unknown" };

/** `/r/{did}/{collection}/{rkey}/{cid}`, canonicalised like the blob path. */
export function parseScopedPath(pathname: string): ScopedPath {
	const segments = pathname.split("/");
	if (segments.length !== 6 || segments[0] !== "" || segments[1] !== "r")
		return { kind: "unknown" };
	const [, , rawDid, collection, rkey, rawCid] = segments as [
		string,
		string,
		string,
		string,
		string,
		string,
	];
	if (!isValidCollection(collection) || !isValidRkey(rkey)) return { kind: "invalid" };
	const blob = parseBlobPath(`/${rawDid}/${rawCid}`);
	if (blob.kind !== "blob" && blob.kind !== "redirect") return { kind: "invalid" };
	const canonicalBlob = blob.kind === "blob" ? `/${blob.did}/${blob.cid}` : blob.location;
	const [did, cid] = canonicalBlob.slice(1).split("/") as [string, string];
	const canonical = `/r/${did}/${collection}/${rkey}/${cid}`;
	if (canonical !== pathname) return { kind: "redirect", location: canonical };
	if (!CID_PATTERN.test(cid)) return { kind: "invalid" };
	return { kind: "scoped", did, collection, rkey, cid };
}

export type Admission = { kind: "admit"; tags: string[] } | { kind: "deny"; response: Response };

/**
 * Forward membership check (SPEC.md §8b): the collection must be
 * allowlisted and the requested cid must be among the record's blob refs.
 * Denials are cached a day and tagged so a record purge clears them.
 */
export async function admit(
	ref: ScopedRef,
	env: Env,
	ctx: ExecutionContext,
	config: Config,
): Promise<Admission> {
	const record = recordTag(ref.did, ref.collection, ref.rkey);
	const tags = [...blobTags(ref.did, ref.cid), record, versionTag(env)];
	if (!collectionMatches(ref.collection, config.scopedCollections)) {
		return {
			kind: "deny",
			response: errorResponse({
				status: 403,
				cacheControl: CACHE_CONTROL.day,
				tags,
				message: "Collection is not served by this proxy",
			}),
		};
	}
	const response = await ctx.exports.Record.fetch(
		`http://record/record/${ref.did}/${ref.collection}/${ref.rkey}`,
	);
	if (response.status === 404) {
		await response.body?.cancel();
		return {
			kind: "deny",
			response: errorResponse({
				status: 404,
				cacheControl: CACHE_CONTROL.negative,
				tags,
				message: "Record not found",
			}),
		};
	}
	if (!response.ok) {
		return {
			kind: "deny",
			response: errorResponse({
				status: 502,
				cacheControl: CACHE_CONTROL.noStore,
				message: `Record returned ${response.status}: ${await response.text()}`,
			}),
		};
	}
	const info = (await response.json()) as RecordInfo;
	if (!info.blobs.includes(ref.cid)) {
		return {
			kind: "deny",
			response: errorResponse({
				status: 403,
				cacheControl: CACHE_CONTROL.day,
				tags,
				message: "Blob is not referenced by this record",
			}),
		};
	}
	return { kind: "admit", tags: [record] };
}
