import { defineWorker } from "@cloudflare/vite-plugin/experimental-config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineWorker({
	name: "cumulus",
	entrypoint,
	compatibilityDate,
	compatibilityFlags,
	observability: {
		enabled: true,
	},
});
