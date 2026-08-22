export interface Config {
	blobMaxSize: number;
	allowedMimeTypes: ReadonlySet<string>;
	blobFetchTimeoutMs: number;
	plcUrl: string;
	browserMaxAge: number;
	edgeMaxAge: number;
}

const DEFAULT_MIMETYPES = "image/jpeg,image/png,image/webp,image/avif,image/gif";

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

export type ConfigEnv = Partial<
	Record<
		| "BLOB_MAX_SIZE"
		| "BLOB_ALLOWED_MIMETYPES"
		| "BLOB_FETCH_TIMEOUT"
		| "PLC_URL"
		| "BROWSER_MAX_AGE"
		| "EDGE_MAX_AGE",
		string
	>
>;

export function loadConfig(env: ConfigEnv): Config {
	return {
		blobMaxSize: parseSize(env.BLOB_MAX_SIZE ?? "25mb"),
		allowedMimeTypes: new Set(
			(env.BLOB_ALLOWED_MIMETYPES ?? DEFAULT_MIMETYPES)
				.split(",")
				.map((type) => type.trim().toLowerCase())
				.filter(Boolean),
		),
		blobFetchTimeoutMs: parseDuration(env.BLOB_FETCH_TIMEOUT ?? "30s"),
		plcUrl: (env.PLC_URL ?? "https://plc.directory").replace(/\/+$/, ""),
		browserMaxAge: parseInteger(env.BROWSER_MAX_AGE ?? "3600"),
		edgeMaxAge: parseInteger(env.EDGE_MAX_AGE ?? "31536000"),
	};
}
