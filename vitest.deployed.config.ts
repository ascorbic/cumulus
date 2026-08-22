import { defineConfig } from "vite-plus";

// HTTP-only suite against a deployed Worker; runs on Node, not workerd.
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 60_000,
		fileParallelism: false,
	},
});
