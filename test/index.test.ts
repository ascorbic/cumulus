import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker", () => {
	it("responds with a greeting", async () => {
		const response = await exports.default.fetch("https://example.com/");
		expect(await response.text()).toBe("Hello from worker-template");
	});

	it("serves the JSON API route", async () => {
		const response = await exports.default.fetch("https://example.com/api/hello");
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ hello: "world" });
	});
});
