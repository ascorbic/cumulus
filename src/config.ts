export interface Config {
	blobMaxSize: number;
	allowedMimeTypes: ReadonlySet<string>;
	blobFetchTimeoutMs: number;
	plcUrl: string;
	browserMaxAge: number;
	edgeMaxAge: number;
}

export const CONFIG_DEFAULTS = {
	BLOB_MAX_SIZE: "3mb",
	BLOB_ALLOWED_MIMETYPES: "image/jpeg,image/png,image/webp,image/avif,image/gif",
	BLOB_FETCH_TIMEOUT: "30s",
	PLC_URL: "https://plc.directory",
	BROWSER_MAX_AGE: "3600",
	EDGE_MAX_AGE: "31536000",
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

export function loadConfig(env: object): Config {
	const vars = env as ConfigEnv;
	const get = (key: keyof typeof CONFIG_DEFAULTS): string => vars[key] || CONFIG_DEFAULTS[key];
	return {
		blobMaxSize: parseSize(get("BLOB_MAX_SIZE")),
		allowedMimeTypes: new Set(
			get("BLOB_ALLOWED_MIMETYPES")
				.split(",")
				.map((type) => type.trim().toLowerCase())
				.filter(Boolean),
		),
		blobFetchTimeoutMs: parseDuration(get("BLOB_FETCH_TIMEOUT")),
		plcUrl: get("PLC_URL").replace(/\/+$/, ""),
		browserMaxAge: parseInteger(get("BROWSER_MAX_AGE")),
		edgeMaxAge: parseInteger(get("EDGE_MAX_AGE")),
	};
}
