export interface Config {
	blobMaxSize: number;
	allowedMimeTypes: ReadonlySet<string>;
	blobFetchTimeoutMs: number;
	plcUrl: string;
	browserMaxAge: number;
	edgeMaxAge: number;
	policyUrl: string | undefined;
	policyFailOpen: boolean;
}

export const CONFIG_DEFAULTS = {
	BLOB_MAX_SIZE: "3mb",
	BLOB_ALLOWED_MIMETYPES: "image/jpeg,image/png,image/webp,image/avif,image/gif",
	BLOB_FETCH_TIMEOUT: "30s",
	PLC_URL: "https://plc.directory",
	BROWSER_MAX_AGE: "3600",
	EDGE_MAX_AGE: "31536000",
	POLICY_URL: "",
	POLICY_FAIL_OPEN: "false",
} as const;

export type ConfigEnv = Partial<Record<keyof typeof CONFIG_DEFAULTS, string>>;

const SIZE_UNITS: Record<string, number> = {
	b: 1,
	kb: 1024,
	mb: 1024 ** 2,
	gb: 1024 ** 3,
};

const DURATION_UNITS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60_000,
};

export function parseSize(value: string): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
	if (!match) throw new Error(`Invalid size: ${value}`);
	const unit = SIZE_UNITS[(match[2] || "b").toLowerCase()];
	if (unit === undefined) throw new Error(`Invalid size unit: ${value}`);
	return Math.floor(Number(match[1]) * unit);
}

export function parseDuration(value: string): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
	if (!match) throw new Error(`Invalid duration: ${value}`);
	const unit = DURATION_UNITS[(match[2] || "ms").toLowerCase()];
	if (unit === undefined) throw new Error(`Invalid duration unit: ${value}`);
	return Math.floor(Number(match[1]) * unit);
}

function parseInteger(value: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`Invalid integer: ${value}`);
	return Number(value);
}

function parseBoolean(value: string): boolean {
	const lower = value.trim().toLowerCase();
	if (lower === "true" || lower === "1" || lower === "yes") return true;
	if (lower === "false" || lower === "0" || lower === "no") return false;
	throw new Error(`Invalid boolean: ${value}`);
}

function configValue(env: object, key: keyof typeof CONFIG_DEFAULTS): string {
	return (env as ConfigEnv)[key] || CONFIG_DEFAULTS[key];
}

export function loadConfig(env: object): Config {
	const policyUrl = configValue(env, "POLICY_URL").replace(/\/+$/, "");
	return {
		blobMaxSize: parseSize(configValue(env, "BLOB_MAX_SIZE")),
		allowedMimeTypes: new Set(
			configValue(env, "BLOB_ALLOWED_MIMETYPES")
				.split(",")
				.map((type) => type.trim().toLowerCase())
				.filter(Boolean),
		),
		blobFetchTimeoutMs: parseDuration(configValue(env, "BLOB_FETCH_TIMEOUT")),
		plcUrl: configValue(env, "PLC_URL").replace(/\/+$/, ""),
		browserMaxAge: parseInteger(configValue(env, "BROWSER_MAX_AGE")),
		edgeMaxAge: parseInteger(configValue(env, "EDGE_MAX_AGE")),
		policyUrl: policyUrl || undefined,
		policyFailOpen: parseBoolean(configValue(env, "POLICY_FAIL_OPEN")),
	};
}

const configHashes = new Map<string, Promise<string>>();

/**
 * Identifies the configuration that decides 413/415 verdicts, so those
 * cached responses can be purged by tag when the allowlist or size cap changes.
 */
export function configHash(env: object): Promise<string> {
	const input = `${configValue(env, "BLOB_ALLOWED_MIMETYPES")}\n${configValue(env, "BLOB_MAX_SIZE")}`;
	let hash = configHashes.get(input);
	if (!hash) {
		hash = crypto.subtle
			.digest("SHA-256", new TextEncoder().encode(input))
			.then((digest) =>
				Array.from(new Uint8Array(digest).subarray(0, 8), (b) =>
					b.toString(16).padStart(2, "0"),
				).join(""),
			);
		configHashes.set(input, hash);
	}
	return hash;
}
