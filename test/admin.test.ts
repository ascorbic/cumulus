import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TEST_ADMIN_PASSWORD } from "./constants.ts";
import { DID } from "./helpers.ts";

const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const ORIGIN = "https://cumulus.example";

function basic(password: string, user = "admin"): string {
	return "Basic " + btoa(`${user}:${password}`);
}

const post = (path: string, auth = basic(TEST_ADMIN_PASSWORD)) =>
	exports.default.fetch(
		new Request(ORIGIN + path, { method: "POST", headers: auth ? { authorization: auth } : {} }),
	);

interface PurgeBody {
	success: boolean;
	results: Record<"default" | "Policy" | "Identity", { success: boolean; errors: unknown[] }>;
}

describe("admin purge", () => {
	it("requires Basic auth", async () => {
		const missing = await post(`/admin/purge/actor/${DID}`, "");
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toContain("Basic");
		expect(missing.headers.get("cache-control")).toBe("no-store");
		const wrong = await post(`/admin/purge/actor/${DID}`, basic("wrong"));
		expect(wrong.status).toBe(401);
	});

	it("only accepts POST", async () => {
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}/admin/purge/actor/${DID}`, {
				headers: { authorization: basic(TEST_ADMIN_PASSWORD) },
			}),
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("validates identifiers", async () => {
		expect((await post("/admin/purge/actor/did:plc:nope")).status).toBe(400);
		expect((await post("/admin/purge/blob/Bafkrei")).status).toBe(400);
		expect((await post("/admin/purge/version/latest")).status).toBe(400);
		expect((await post("/admin/purge/all/extra")).status).toBe(404);
		expect((await post("/admin/purge/everything")).status).toBe(404);
	});

	// The test runtime has no ctx.cache, so every purge reports failure; the
	// fan-out shape and the RPC round-trips through Policy/Identity are what
	// these assert. Real purges are verified against the deployed Worker.
	it("fans an actor purge out to every entrypoint", async () => {
		const response = await post(`/admin/purge/actor/${DID}`);
		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = (await response.json()) as PurgeBody;
		expect(body.success).toBe(false);
		expect(Object.keys(body.results)).toEqual(["default", "Policy", "Identity"]);
		for (const result of Object.values(body.results)) {
			expect(result.success).toBe(false);
			expect(result.errors[0]).toMatchObject({ message: expect.stringContaining("ctx.cache") });
		}
	});

	it("skips Identity for a blob purge", async () => {
		const body = (await (await post(`/admin/purge/blob/${CID}`)).json()) as PurgeBody;
		expect(body.results.Identity).toEqual({ success: true, errors: [] });
		expect(body.results.default.success).toBe(false);
		expect(body.results.Policy.success).toBe(false);
	});

	it("purges everything on every entrypoint", async () => {
		const body = (await (await post("/admin/purge/all")).json()) as PurgeBody;
		expect(Object.keys(body.results)).toEqual(["default", "Policy", "Identity"]);
	});

	it("reports the config hash and purges it on default only", async () => {
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}/admin/config`, {
				headers: { authorization: basic(TEST_ADMIN_PASSWORD) },
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const { hash, config } = (await response.json()) as {
			hash: string;
			config: { blobMaxSize: number };
		};
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
		expect(config.blobMaxSize).toBe(3 * 1024 * 1024);
		const body = (await (await post(`/admin/purge/config/${hash}`)).json()) as PurgeBody;
		expect(body.results.Policy).toEqual({ success: true, errors: [] });
		expect(body.results.Identity).toEqual({ success: true, errors: [] });
		expect(body.results.default.success).toBe(false);
		expect((await post("/admin/purge/config/nothex")).status).toBe(400);
		expect((await post("/admin/config")).status).toBe(405);
	});

	it("reports labeler status", async () => {
		const response = await exports.default.fetch(
			new Request(`${ORIGIN}/admin/labels/status`, {
				headers: { authorization: basic(TEST_ADMIN_PASSWORD) },
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ labelers: [] });
		expect((await post("/admin/labels/status")).status).toBe(405);
		expect((await post("/admin/labels/nope")).status).toBe(404);
	});

	it("purges a version tag on every entrypoint", async () => {
		const body = (await (
			await post("/admin/purge/version/9bc2de5a-1a13-472e-b846-af6f00fec3f1")
		).json()) as PurgeBody;
		expect(Object.keys(body.results)).toEqual(["default", "Policy", "Identity"]);
	});
});
