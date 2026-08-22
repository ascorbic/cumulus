import {
	bindings,
	defineWorker,
	exports,
	triggers,
} from "@cloudflare/vite-plugin/experimental-config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineWorker({
	name: "cumulus",
	entrypoint,
	// Keep in sync with vite.config.ts so tests run on the deployed runtime.
	compatibilityDate: "2026-08-22",
	// Serve only from the attached custom domain so zone WAF rules see all traffic.
	workersDev: false,
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
		LABELS_KV: bindings.kv(),
		// Set with `pnpm admin:password`.
		ADMIN_PASSWORD: bindings.secret(),
		// Remove this binding to disable the /img/ presets.
		IMAGES: bindings.images(),
		// Cache misses per client IP, and per client IP + DID (blob enumeration).
		MISS_LIMIT_IP: bindings.rateLimit({ namespace: "1001", simple: { limit: 600, period: 60 } }),
		MISS_LIMIT_DID: bindings.rateLimit({ namespace: "1002", simple: { limit: 120, period: 60 } }),

		// Settings. The README's Configuration section documents each one.
		BLOB_MAX_SIZE: bindings.text("3mb"),
		BLOB_ALLOWED_MIMETYPES: bindings.text("image/jpeg,image/png,image/webp,image/avif,image/gif"),
		BLOB_FETCH_TIMEOUT: bindings.text("30s"),
		PLC_URL: bindings.text("https://plc.directory"),
		BROWSER_MAX_AGE: bindings.text("3600"),
		EDGE_MAX_AGE: bindings.text("31536000"),
		LABELERS: bindings.text('[{"did":"did:plc:ar7c4by46qjdydhdevvrndac","vals":["!takedown"]}]'),
		LABELER_FAIL_OPEN: bindings.text("true"),
		POLICY_URL: bindings.text(""),
		POLICY_FAIL_OPEN: bindings.text("false"),
		MODE: bindings.text("open"),
		SCOPED_COLLECTIONS: bindings.text(""),
		JETSTREAM_URL: bindings.text(""),
	},
	triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
	observability: {
		enabled: true,
	},
});
