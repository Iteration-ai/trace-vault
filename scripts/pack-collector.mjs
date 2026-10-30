import { mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const { version } = JSON.parse(
	await readFile("packages/cli/package.json", "utf8"),
);
await mkdir("artifacts", { recursive: true });
const tarball = path.resolve(
	`artifacts/thytu-trace-vault-collector-${version}.tgz`,
);
await rm(tarball, { force: true });
execFileSync(
	"pnpm",
	[
		"--filter",
		"@thytu/trace-vault-collector",
		"pack",
		"--pack-destination",
		path.resolve("artifacts"),
	],
	{ stdio: "inherit" },
);
process.stdout.write(`${tarball}\n`);
