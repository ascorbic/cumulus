// Generates ADMIN_PASSWORD, stores it in .env and sets it as the Worker secret.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const worker = process.argv[2] ?? "cumulus";
const password = randomBytes(30).toString("base64url");
const lines = existsSync(".env") ? readFileSync(".env", "utf8").split("\n") : [];
const kept = lines.filter((line) => !line.startsWith("ADMIN_PASSWORD="));
while (kept.at(-1) === "") kept.pop();
writeFileSync(".env", [...kept, `ADMIN_PASSWORD=${password}`, ""].join("\n"));

const result = spawnSync(
	"pnpm",
	["cf", "workers", "secrets", "update", "ADMIN_PASSWORD", "--worker", worker, "--text", password],
	{ stdio: "inherit" },
);
if (result.status !== 0) {
	console.error(
		"Password written to .env, but setting the Worker secret failed. Deploy once, then rerun.",
	);
	process.exit(result.status ?? 1);
}
console.log(`ADMIN_PASSWORD set on ${worker} and saved to .env`);
