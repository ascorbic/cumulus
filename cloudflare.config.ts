import { bindings, defineWorker, exports } from "@cloudflare/vite-plugin/experimental-config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import { CONFIG_DEFAULTS } from "./src/config.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineWorker({
	name: "cumulus",
	entrypoint,
	compatibilityDate,
	compatibilityFlags,
	cache: {
		enabled: true,
		crossVersionCache: true,
	},
	exports: {
		Identity: exports.worker({ cache: { enabled: true } }),
		Policy: exports.worker({ cache: { enabled: true } }),
	},
	env: {
		VERSION: bindings.versionMetadata(),
		ADMIN_PASSWORD: bindings.secret(),
		BLOB_MAX_SIZE: bindings.text(CONFIG_DEFAULTS.BLOB_MAX_SIZE),
		BLOB_ALLOWED_MIMETYPES: bindings.text(CONFIG_DEFAULTS.BLOB_ALLOWED_MIMETYPES),
		BLOB_FETCH_TIMEOUT: bindings.text(CONFIG_DEFAULTS.BLOB_FETCH_TIMEOUT),
		PLC_URL: bindings.text(CONFIG_DEFAULTS.PLC_URL),
		BROWSER_MAX_AGE: bindings.text(CONFIG_DEFAULTS.BROWSER_MAX_AGE),
		EDGE_MAX_AGE: bindings.text(CONFIG_DEFAULTS.EDGE_MAX_AGE),
	},
	observability: {
		enabled: true,
	},
});
