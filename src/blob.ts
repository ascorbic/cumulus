export type BlobResult =
	| { status: "ok"; bytes: Uint8Array; digest: Uint8Array }
	| { status: "not-found" }
	| { status: "too-large" }
	| { status: "upstream-error"; detail: string };

export function getBlobUrl(pds: string, did: string, cid: string): string {
	const url = new URL(`${pds}/xrpc/com.atproto.sync.getBlob`);
	url.searchParams.set("did", did);
	url.searchParams.set("cid", cid);
	return url.href;
}

async function isBlobNotFound(response: Response): Promise<boolean> {
	if (response.status === 404) return true;
	if (response.status !== 400) return false;
	try {
		const body = (await response.clone().json()) as { error?: unknown };
		return body.error === "BlobNotFound" || body.error === "RepoNotFound";
	} catch {
		return false;
	}
}

/**
 * Fetches a blob and buffers it fully while hashing. Nothing is returned until
 * every byte is in memory, so callers can verify before serving.
 */
export async function fetchBlob(
	pds: string,
	did: string,
	cid: string,
	options: { maxSize: number; timeoutMs: number },
): Promise<BlobResult> {
	let response: Response;
	try {
		response = await fetch(getBlobUrl(pds, did, cid), {
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch (error) {
		return { status: "upstream-error", detail: String(error) };
	}
	if (!response.ok) {
		if (await isBlobNotFound(response)) return { status: "not-found" };
		await response.body?.cancel();
		return { status: "upstream-error", detail: `PDS returned ${response.status}` };
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > options.maxSize) {
		await response.body?.cancel();
		return { status: "too-large" };
	}
	if (!response.body) return { status: "upstream-error", detail: "PDS returned no body" };

	const digestStream = new crypto.DigestStream("SHA-256");
	// Aborting the stream rejects `digest`; that rejection is only relevant on
	// the success path where it is awaited.
	digestStream.digest.catch(() => {});
	const writer = digestStream.getWriter();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > options.maxSize) {
				await reader.cancel();
				await writer.abort();
				return { status: "too-large" };
			}
			chunks.push(value);
			await writer.write(value);
		}
		await writer.close();
	} catch (error) {
		await writer.abort().catch(() => {});
		return { status: "upstream-error", detail: `PDS body read failed: ${String(error)}` };
	}
	const bytes = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { status: "ok", bytes, digest: new Uint8Array(await digestStream.digest) };
}
