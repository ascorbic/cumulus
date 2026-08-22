import {
	bindings,
	defineWorker,
	exports,
	triggers,
} from "@cloudflare/vite-plugin/experimental-config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import { CONFIG_DEFAULTS } from "./src/config.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/** Deploy-time overrides come from the environment (`.env` locally). */
function setting(key: keyof typeof CONFIG_DEFAULTS): string {
	return process.env[key] ?? CONFIG_DEFAULTS[key];
}

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
		Record: exports.worker({ cache: { enabled: true } }),
	},
	env: {
		VERSION: bindings.versionMetadata(),
		ADMIN_PASSWORD: bindings.secret(),
		BLOB_MAX_SIZE: bindings.text(setting("BLOB_MAX_SIZE")),
		BLOB_ALLOWED_MIMETYPES: bindings.text(setting("BLOB_ALLOWED_MIMETYPES")),
		BLOB_FETCH_TIMEOUT: bindings.text(setting("BLOB_FETCH_TIMEOUT")),
		PLC_URL: bindings.text(setting("PLC_URL")),
		BROWSER_MAX_AGE: bindings.text(setting("BROWSER_MAX_AGE")),
		EDGE_MAX_AGE: bindings.text(setting("EDGE_MAX_AGE")),
		POLICY_URL: bindings.text(setting("POLICY_URL")),
		POLICY_FAIL_OPEN: bindings.text(setting("POLICY_FAIL_OPEN")),
		LABELERS: bindings.text(setting("LABELERS")),
		LABELER_FAIL_OPEN: bindings.text(setting("LABELER_FAIL_OPEN")),
		MODE: bindings.text(setting("MODE")),
		SCOPED_COLLECTIONS: bindings.text(setting("SCOPED_COLLECTIONS")),
		JETSTREAM_URL: bindings.text(setting("JETSTREAM_URL")),
		LABELS_KV: bindings.kv(),
		...(process.env.IMAGES_ENABLED === "true" ? { IMAGES: bindings.images() } : {}),
	},
	triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
	observability: {
		enabled: true,
	},
});
