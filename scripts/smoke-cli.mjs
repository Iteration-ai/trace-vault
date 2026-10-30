import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { version } = JSON.parse(
	await readFile("packages/cli/package.json", "utf8"),
);
const tarball = path.resolve(`artifacts/iteration-cli-${version}.tgz`);
const directory = await mkdtemp(path.join(os.tmpdir(), "iteration-pack-"));
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
		{
			cwd: directory,
			stdio: "inherit",
		},
	);
	const root = path.join(directory, "node_modules", "iteration-cli");
	const manifest = JSON.parse(
		await readFile(path.join(root, "package.json"), "utf8"),
	);
	assert.equal(manifest.name, "iteration-cli");
	assert.equal(manifest.version, version);
	assert.deepEqual(manifest.bin, {
		iteration: "./dist/cli.js",
		"trace-vault": "./dist/vault-cli.js",
	});
	for (const field of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	])
		assert.equal(Object.keys(manifest[field] ?? {}).length, 0);
	assert.deepEqual((await readdir(path.join(root, "dist"))).sort(), [
		"LICENSE",
		"NOTICE",
		"OPEN-SOURCE.md",
		"THIRD-PARTY-NOTICES.txt",
		"cli.js",
		"cursor-hook-entry.js",
		"launcher.js",
		"vault-cli.js",
	]);
	const home = path.join(directory, "home");
	await mkdir(home);
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		NODE_PATH: "",
		NODE_OPTIONS: "",
	};
	const run = (file, args, input) =>
		execFileSync(file, args, {
			cwd: directory,
			env,
			encoding: "utf8",
			input,
			timeout: 30_000,
		});
	const iteration = path.join(directory, "node_modules", ".bin", "iteration");
	const vault = path.join(directory, "node_modules", ".bin", "trace-vault");
	assert.match(run(iteration, ["--help"]), /Iteration CLI/);
	assert.match(run(iteration, ["connect", "--help"]), /--workspace ID/);
	assert.equal(run(iteration, ["version"]).trim(), version);
	assert.equal(run(iteration, ["self-check"]).trim(), version);
	assert.match(run(iteration, ["update", "off"]), /Automatic updates are off/);
	const settingsFile = path.join(
		home,
		".config",
		"iteration",
		"runtime",
		"settings.json",
	);
	assert.equal(
		JSON.parse(await readFile(settingsFile, "utf8")).autoUpdate,
		false,
	);
	assert.match(run(iteration, ["update", "on"]), /Automatic updates are on/);
	assert.equal(
		JSON.parse(await readFile(settingsFile, "utf8")).autoUpdate,
		true,
	);
	assert.match(run(vault, ["--help"]), /trace-vault connect/);
	assert.equal(
		run(iteration, []).split("\n")[0],
		"Run iteration connect in a terminal.",
	);

	const runtime = path.join(home, ".config", "iteration", "runtime");
	const stateFile = path.join(runtime, "state.json");
	await assert.rejects(readFile(stateFile), { code: "ENOENT" });
	await mkdir(runtime, { recursive: true });
	await writeFile(
		stateFile,
		JSON.stringify({
			version: 1,
			current: version,
			previous: null,
			trial: null,
			rejected: [],
			lastCheck: null,
			lastUpdate: null,
		}),
	);
	run(iteration, []);
	const state = () => readFile(stateFile, "utf8").then(JSON.parse);
	assert.equal((await state()).current, version);
	const launcher = path.join(runtime, "launcher.js");
	assert.equal(
		run(process.execPath, [launcher, "launcher-check"]).trim(),
		version,
	);
	assert.equal(run(process.execPath, [launcher, "version"]).trim(), version);
	const cursorData = path.join(directory, "cursor");
	assert.equal(
		run(
			process.execPath,
			[launcher, "cursor-hook", "beforeSubmitPrompt", cursorData],
			'{"conversation_id":"synthetic-smoke"}',
		).trim(),
		'{"continue":true}',
	);
	const queue = path.join(cursorData, "cursor-hooks");
	const records = (await readdir(queue)).filter((name) =>
		name.endsWith(".jsonl"),
	);
	assert.equal(records.length, 1);
	assert.match(
		await readFile(path.join(queue, records[0]), "utf8"),
		/synthetic-smoke/,
	);

	// A failed candidate must not replace the known-good background runtime.
	const candidate = "999.0.0";
	const candidateRoot = path.join(runtime, "versions", candidate);
	await cp(root, candidateRoot, { recursive: true });
	await writeFile(
		path.join(candidateRoot, "package.json"),
		JSON.stringify({ ...manifest, version: candidate }),
	);
	await writeFile(
		path.join(candidateRoot, "dist", "cli.js"),
		'process.stderr.write("synthetic startup failure\\n"); process.exitCode = 1;',
	);
	await writeFile(
		stateFile,
		JSON.stringify({
			...(await state()),
			current: candidate,
			previous: version,
			trial: {
				version: candidate,
				previous: version,
				startedAtMs: Date.now(),
				expected: ["codex"],
				starts: {},
				confirmed: [],
			},
		}),
	);
	for (let attempt = 0; attempt < 4; attempt++) {
		const result = spawnSync(process.execPath, [launcher, "run", "codex"], {
			cwd: directory,
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
		if (result.error) throw result.error;
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			attempt < 3 ? /synthetic startup failure/ : /config/,
		);
	}
	const rolledBack = await state();
	assert.equal(rolledBack.current, version);
	assert.equal(rolledBack.trial, null);
	assert.equal(rolledBack.rejected[0].version, candidate);
	assert.equal(run(iteration, ["version"]).trim(), version);
	process.stdout.write(
		`Packed iteration-cli ${version}: both installed entrypoints, version lookup, runtime adoption, launcher, Cursor hook and failed-trial rollback passed.\n`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
