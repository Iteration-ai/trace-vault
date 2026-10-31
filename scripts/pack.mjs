import { mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const target = process.argv[2];
if (!["cli", "vault-collector", "trace-contracts"].includes(target))
	throw new Error("Choose cli, vault-collector or trace-contracts to pack.");
const { name, version } = JSON.parse(
	await readFile(`packages/${target}/package.json`, "utf8"),
);
await mkdir("artifacts", { recursive: true });
const tarball = path.resolve(
	`artifacts/${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`,
);
await rm(tarball, { force: true });
execFileSync(
	"pnpm",
	["--filter", name, "pack", "--pack-destination", path.resolve("artifacts")],
	{ stdio: "inherit" },
);
process.stdout.write(`${tarball}\n`);
