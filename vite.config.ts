import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import { TEST_ADMIN_PASSWORD } from "./test/constants.ts";

export default defineConfig({
	// The cloudflare() dev/build plugin and the cloudflareTest() plugin (which
	// runs tests inside workerd) must not be active at the same time.
	plugins: [
		process.env.VITEST
			? cloudflareTest({
					main: "./src/index.ts",
					miniflare: {
						compatibilityDate,
						compatibilityFlags,
						versionMetadata: "VERSION",
						kvNamespaces: ["LABELS_KV"],
						bindings: { ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
					},
				})
			: cloudflare({ experimental: { newConfig: true } }),
	],
	test: {
		exclude: ["test/integration/**", "node_modules/**"],
	},
	lint: {
		ignorePatterns: [".cloudflare/**", ".wrangler/**", "dist/**", "worker-configuration.d.ts"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		useTabs: true,
		ignorePatterns: [
			".cloudflare/**",
			".wrangler/**",
			"dist/**",
			".claude/docs/**",
			"worker-configuration.d.ts",
		],
	},
});
