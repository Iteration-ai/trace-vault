import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { version } = JSON.parse(
	await readFile("packages/trace-contracts/package.json", "utf8"),
);
const tarball = path.resolve(
	`artifacts/iteration-trace-contracts-${version}.tgz`,
);
const directory = await mkdtemp(path.join(os.tmpdir(), "contracts-pack-"));
try {
	execFileSync(
		"npm",
		[
			"install",
			"--prefix",
			directory,
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			tarball,
		],
		{ cwd: directory, stdio: "inherit" },
	);
	const expected = '["codex","claude","cursor"]';
	for (const [mode, code] of [
		[
			"module",
			'import { COLLECTOR_SOURCES } from "iteration-trace-contracts"; console.log(JSON.stringify(COLLECTOR_SOURCES));',
		],
		[
			"commonjs",
			'const { COLLECTOR_SOURCES } = require("iteration-trace-contracts"); console.log(JSON.stringify(COLLECTOR_SOURCES));',
		],
	]) {
		const result = execFileSync(
			process.execPath,
			[`--input-type=${mode}`, "-e", code],
			{
				cwd: directory,
				encoding: "utf8",
				env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
				timeout: 30_000,
			},
		);
		assert.equal(result.trim(), expected);
	}
	process.stdout.write(
		`Packed contracts ${version}: isolated npm install, native ESM import and Node 22 require(ESM) passed.\n`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
