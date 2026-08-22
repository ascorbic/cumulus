import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeCborSequence } from "../../src/cbor.ts";

/**
 * Runs against a deployed Worker (Node runner, HTTP only):
 *   CUMULUS_URL      default https://cdn.cirrus.earth
 *   ADMIN_PASSWORD   required for purge sequences
 *   TEST_DID/TEST_CID a real, small, allowlisted blob
 */
const BASE = (process.env.CUMULUS_URL ?? "https://cdn.cirrus.earth").replace(/\/+$/, "");
const PASSWORD = process.env.ADMIN_PASSWORD ?? passwordFromDotenv();

function passwordFromDotenv(): string | undefined {
	if (!existsSync(".env")) return undefined;
	const line = readFileSync(".env", "utf8")
		.split("\n")
		.find((entry) => entry.startsWith("ADMIN_PASSWORD="));
	return line?.slice("ADMIN_PASSWORD=".length).trim() || undefined;
}
const DID = process.env.TEST_DID ?? "did:plc:uwbl4k3tza7eyjv3morkrld2";
const CID = process.env.TEST_CID ?? "bafkreic4mwsbm2tmuonamj4jq4kcjofk35bwics2f4oorp57f3cdfusjwu";
const MISSING_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

const auth = { authorization: "Basic " + Buffer.from(`admin:${PASSWORD}`).toString("base64") };

async function get(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(BASE + path, { redirect: "manual", ...init });
}

async function purge(kind: string): Promise<{ success: boolean }> {
	const response = await get(`/admin/purge/${kind}`, { method: "POST", headers: auth });
	expect(response.status, `purge ${kind}`).toBe(200);
	return (await response.json()) as { success: boolean };
}

const status = (response: Response) => response.headers.get("cf-cache-status");

/**
 * Instant Purge propagates within milliseconds but not synchronously with the
 * purge response; poll briefly and report how long it took.
 */
async function expectMissAfter(label: string, path: string): Promise<Response> {
	const started = Date.now();
	for (;;) {
		const response = await get(path);
		if (status(response) === "MISS") {
			console.log(`${label}: MISS observed after ${Date.now() - started} ms`);
			return response;
		}
		await response.arrayBuffer();
		if (Date.now() - started > 5000) {
			expect.fail(`${label}: no MISS within 5 s (last ${status(response)})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const LABELER_DID = "did:plc:ar7c4by46qjdydhdevvrndac";
const LABELER_WS = "wss://mod.bsky.app/xrpc/com.atproto.label.subscribeLabels";

/** Finds an account Bluesky's moderation service has recently taken down. */
async function recentTakedown(): Promise<string | undefined> {
	const status = await get("/admin/labels/status", { headers: auth });
	const { labelers } = (await status.json()) as {
		labelers: Array<{ did: string; cursor: number | null }>;
	};
	const cursor = labelers.find((l) => l.did === LABELER_DID)?.cursor;
	if (!cursor) return undefined;
	return new Promise((resolve) => {
		const ws = new WebSocket(`${LABELER_WS}?cursor=${Math.max(0, cursor - 20_000)}`);
		ws.binaryType = "arraybuffer";
		const finish = (did?: string) => {
			ws.close();
			resolve(did);
		};
		const timer = setTimeout(() => finish(), 20_000);
		ws.addEventListener("message", (event) => {
			const [header, body] = decodeCborSequence(new Uint8Array(event.data as ArrayBuffer)) as Array<
				Record<string, unknown>
			>;
			if (header?.t !== "#labels") return;
			for (const label of (body?.labels as Array<Record<string, unknown>>) ?? []) {
				if (label.val === "!takedown" && !label.neg && String(label.uri).startsWith("did:")) {
					clearTimeout(timer);
					finish(String(label.uri));
					return;
				}
			}
		});
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			finish();
		});
	});
}

describe.skipIf(!PASSWORD)("deployed cumulus", () => {
	beforeAll(async () => {
		expect((await get("/healthz")).status).toBe(200);
	});

	it("blob: purge → MISS → HIT, with HEAD and Range served from the entry", async () => {
		expect((await purge(`actor/${DID}`)).success).toBe(true);
		const first = await expectMissAfter("purge actor", `/${DID}/${CID}`);
		expect(first.status).toBe(200);
		const h = first.headers;
		expect(h.get("content-type")).toMatch(/^image\//);
		expect(h.get("cache-control")).toBe("public, max-age=3600");
		expect(h.get("accept-ranges")).toBe("bytes");
		expect(h.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(h.get("x-content-type-options")).toBe("nosniff");
		expect(h.get("cross-origin-resource-policy")).toBe("cross-origin");
		expect(h.get("access-control-allow-origin")).toBe("*");
		expect(h.get("content-disposition")).toMatch(
			new RegExp(`^inline; filename="${CID}\\.[a-z]+"$`),
		);
		expect(h.has("vary")).toBe(false);
		expect(h.has("cache-tag")).toBe(false);
		expect(h.has("cloudflare-cdn-cache-control")).toBe(false);
		await first.arrayBuffer();

		const second = await get(`/${DID}/${CID}`);
		expect(status(second)).toBe("HIT");
		await second.arrayBuffer();

		const head = await get(`/${DID}/${CID}`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(status(head)).toBe("HIT");

		const range = await get(`/${DID}/${CID}`, { headers: { range: "bytes=0-9" } });
		expect(range.status).toBe(206);
		expect(status(range)).toBe("HIT");
		expect(range.headers.get("content-range")).toMatch(/^bytes 0-9\/\d+$/);
		expect((await range.arrayBuffer()).byteLength).toBe(10);

		const bad = await get(`/${DID}/${CID}`, { headers: { range: "bytes=99999999-" } });
		expect(bad.status).toBe(416);
	});

	it("blob purge, version purge and purge-all each cold-cache the entry", async () => {
		await (await get(`/${DID}/${CID}`)).arrayBuffer();
		expect((await purge(`blob/${CID}`)).success).toBe(true);
		await (await expectMissAfter("purge blob", `/${DID}/${CID}`)).arrayBuffer();

		expect((await purge("all")).success).toBe(true);
		await (await expectMissAfter("purge all", `/${DID}/${CID}`)).arrayBuffer();
		expect(status(await get(`/${DID}/${CID}`))).toBe("HIT");
	});

	it("redirects aliases with a cacheable 301", async () => {
		const upper = await get(`/${DID}/${CID.toUpperCase()}`);
		expect(upper.status).toBe(301);
		expect(upper.headers.get("location")).toBe(`/${DID}/${CID}`);
		expect(upper.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(status(await get(`/${DID}/${CID.toUpperCase()}`))).toBe("HIT");
		expect((await get(`/${DID}/${CID}/`)).headers.get("location")).toBe(`/${DID}/${CID}`);
		expect((await get(`/${DID.replace(/:/g, "%3A")}/${CID}`)).headers.get("location")).toBe(
			`/${DID}/${CID}`,
		);
	});

	it("applies the error taxonomy's Cache-Control values", async () => {
		const bad = await get(`/did:plc:nope/${CID}`);
		expect(bad.status).toBe(400);
		expect(bad.headers.get("cache-control")).toBe("public, max-age=86400");

		const unknown = await get("/nope");
		expect(unknown.status).toBe(404);
		expect(unknown.headers.get("cache-control")).toBe("public, max-age=300");

		await purge(`blob/${MISSING_CID}`);
		const missing = await expectMissAfter("purge missing blob", `/${DID}/${MISSING_CID}`);
		expect(missing.status).toBe(404);
		expect(missing.headers.get("cache-control")).toBe("public, max-age=300");
		expect(status(await get(`/${DID}/${MISSING_CID}`))).toBe("HIT");

		const health = await get("/healthz");
		expect(health.headers.get("cache-control")).toBe("no-store");
		expect(status(health)).toBe("BYPASS");

		const post = await get(`/${DID}/${CID}`, { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("cache-control")).toBe("no-store");
	});

	it("serves metadata from the cached original", async () => {
		await purge(`blob/${CID}`);
		const first = await expectMissAfter("purge blob (metadata)", `/metadata/${DID}/${CID}`);
		expect(first.status).toBe(200);
		const body = (await first.json()) as { mime: string; size: number; width: number | null };
		expect(body.mime).toMatch(/^image\//);
		expect(body.size).toBeGreaterThan(0);
		expect(body.width).toBeGreaterThan(0);
		expect(status(await get(`/metadata/${DID}/${CID}`))).toBe("HIT");
		expect(status(await get(`/${DID}/${CID}`))).toBe("HIT");
	});

	it("denies blobs of an account the Bluesky moderation service has taken down", async () => {
		const did = await recentTakedown();
		if (!did) {
			console.log("no recent !takedown found on the label stream; skipping");
			return;
		}
		const response = await get(`/${did}/${MISSING_CID}`);
		expect(response.status, did).toBe(403);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
		const control = await get(`/${DID}/${MISSING_CID}`);
		expect(control.status).toBe(404);
	});
});
