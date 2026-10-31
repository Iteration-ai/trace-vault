import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { name, version } = JSON.parse(
	await readFile("packages/vault-collector/package.json", "utf8"),
);
const published = process.argv[2];
if (published !== undefined) assert.match(published, /^\d+\.\d+\.\d+$/);
const tarball = path.resolve(
	`artifacts/useiteration-trace-vault-collector-${version}.tgz`,
);
const directory = await mkdtemp(path.join(os.tmpdir(), "trace-vault-pack-"));
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
			...(published
				? ["--registry=https://registry.npmjs.org", `${name}@${published}`]
				: ["--offline", tarball]),
		],
		{ cwd: directory, stdio: "inherit" },
	);
	const root = path.join(directory, "node_modules", name);
	const manifest = JSON.parse(
		await readFile(path.join(root, "package.json"), "utf8"),
	);
	assert.equal(manifest.name, "@useiteration/trace-vault-collector");
	assert.equal(manifest.version, published ?? version);
	assert.deepEqual(manifest.bin, { "trace-vault": "./dist/vault-cli.js" });
	for (const field of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	])
		assert.equal(
			Object.keys(manifest[field] ?? {}).length,
			0,
			`unexpected runtime ${field}`,
		);
	assert.deepEqual((await readdir(path.join(root, "dist"))).sort(), [
		"LICENSE",
		"NOTICE",
		"OPEN-SOURCE.md",
		"THIRD-PARTY-NOTICES.txt",
		"vault-cli.js",
	]);
	if (published === undefined) {
		assert.doesNotMatch(
			await readFile(path.join(root, "dist/vault-cli.js"), "utf8"),
			/useiteration\.com|clerk-device-auth|collector-auth\/expand|collector-progress|friction-summary|codex-billing|cursor-billing|ITERATION_RUNTIME_VERSION/,
		);
	}
	const help = execFileSync(
		path.join(directory, "node_modules", ".bin", "trace-vault"),
		["--help"],
		{
			cwd: directory,
			encoding: "utf8",
			env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
		},
	);
	assert.match(help, /trace-vault connect/);
	assert.match(help, /2\.1\.282/);
	assert.match(help, /Codex and Cursor account capture is unsupported/);
	assert.doesNotMatch(help, /iteration start/);
	process.stdout.write(help);
	process.stdout.write(
		`${published ? "Published" : "Packed"} collector ${published ?? version}: isolated ${published ? "public npm" : "offline"} installation and --help passed.\n`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
