import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { version } = JSON.parse(
	await readFile("packages/cli/package.json", "utf8"),
);
const contracts = JSON.parse(
	await readFile("packages/trace-contracts/package.json", "utf8"),
);
const directory = await mkdtemp(
	path.join(os.tmpdir(), "trace-collector-pack-"),
);
try {
	// Pack the pinned local type dependency too, so this check needs no registry.
	const zodRoot = await realpath("packages/cli/node_modules/zod");
	const [zodTarball] = JSON.parse(
		execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
			cwd: zodRoot,
			encoding: "utf8",
		}),
	);
	execFileSync(
		"npm",
		[
			"install",
			"--prefix",
			directory,
			"--offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			path.join(directory, zodTarball.filename),
			path.resolve(
				`artifacts/iteration-trace-contracts-${contracts.version}.tgz`,
			),
			path.resolve(`artifacts/iteration-trace-collector-${version}.tgz`),
		],
		{ cwd: directory, stdio: "inherit" },
	);
	const root = path.join(
		directory,
		"node_modules",
		"iteration-trace-collector",
	);
	const manifest = JSON.parse(
		await readFile(path.join(root, "package.json"), "utf8"),
	);
	assert.equal(manifest.name, "iteration-trace-collector");
	assert.equal(manifest.version, version);
	assert.equal(manifest.bin, undefined);
	assert.deepEqual(Object.keys(manifest.exports), ["."]);
	const bundle = await readFile(path.join(root, "dist/index.js"), "utf8");
	assert.doesNotMatch(
		bundle,
		/useiteration\.com|clerk-device-auth|collector-auth\/expand|collector-progress|friction-summary|codex-billing|cursor-billing|ITERATION_RUNTIME_VERSION/,
	);
	const consumer = path.join(directory, "consumer.mjs");
	await writeFile(
		consumer,
		`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acquireCollectorLock, collectorPaths, collectorTick, initializeState,
  loadConfig, saveConfig, configureCollectorLogging, createLogger
} from "iteration-trace-collector";
await assert.rejects(import("iteration-trace-collector/dist/storage.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const home = path.resolve("claude");
const dataDirectory = path.resolve("data");
await mkdir(path.join(home, "projects", "fixture"), { recursive: true });
await writeFile(path.join(home, "projects", "fixture", "11111111-2222-4333-8444-555555555555.jsonl"), JSON.stringify({
  type: "user", sessionId: "11111111-2222-4333-8444-555555555555",
  uuid: "packaged-record", timestamp: "2026-10-30T12:00:00Z",
  message: { role: "user", content: "synthetic package API smoke" }
}) + "\\n");
const paths = collectorPaths(dataDirectory);
const config = { source: "claude", claudeHome: home, dataDirectory,
  endpoint: "http://localhost/api/traces/ingest", token: "s".repeat(43) };
await saveConfig(config, paths);
assert.deepEqual(await loadConfig(paths), config);
await initializeState("claude", home, paths, true);
const release = await acquireCollectorLock(paths);
await assert.rejects(acquireCollectorLock(paths), /already running/);
let uploaded = [];
const tick = await collectorTick(config, paths, async (_url, request) => {
  uploaded.push(...JSON.parse(request.body).events);
  return Response.json({ deviceId: "22222222-2222-4333-8444-555555555555", acceptedEventIds: uploaded.map(event => event.eventId) }, { status: 202 });
});
assert.equal(tick.uploaded, 1);
assert.equal(tick.outboxBytes, 0);
assert.match(JSON.stringify(uploaded), /synthetic package API smoke/);
await release();
const releaseAgain = await acquireCollectorLock(paths);
await releaseAgain();
let line;
configureCollectorLogging(() => ({ runtimeVersion: "consumer-version" }));
createLogger({ component: "consumer" }, value => { line = value; })({ level: "info", operation: "smoke" });
assert.equal(JSON.parse(line).runtimeVersion, "consumer-version");
console.log("Installed collector API: config, history scan, redaction/upload, outbox acknowledgement, locking and logging passed.");
`,
	);
	const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
	execFileSync(process.execPath, [consumer], {
		cwd: directory,
		env,
		stdio: "inherit",
		timeout: 30_000,
	});
	execFileSync(
		process.execPath,
		[
			"--input-type=commonjs",
			"-e",
			`
const assert = require("node:assert/strict");
const collector = require("iteration-trace-collector");
assert.equal(typeof collector.collectorTick, "function");
assert.equal(typeof collector.acquireCollectorLock, "function");
assert.equal(collector.authenticateAndEnrollCollector, undefined);
assert.equal(collector.updateRuntime, undefined);
`,
		],
		{ cwd: directory, env, stdio: "inherit", timeout: 30_000 },
	);
	await writeFile(
		path.join(directory, "consumer.mts"),
		`
import { collectorPaths, collectorTick, type CollectorConfig, type CollectorFetcher } from "iteration-trace-collector";
const config: CollectorConfig = { codexHome: "/synthetic", dataDirectory: "/synthetic/data", endpoint: "https://example.test/api/traces/ingest", token: "fixture" };
const request: CollectorFetcher = async () => Response.json({ accepted: 0 }, { status: 202 });
void collectorTick(config, collectorPaths(config.dataDirectory), request);
`,
	);
	execFileSync(
		process.execPath,
		[
			path.resolve("node_modules/typescript/bin/tsc"),
			"--noEmit",
			"--strict",
			"--skipLibCheck",
			"--module",
			"NodeNext",
			"--target",
			"ES2022",
			"consumer.mts",
		],
		{
			cwd: directory,
			env,
			stdio: "inherit",
			timeout: 30_000,
		},
	);
	process.stdout.write(
		`Packed collector API ${version}: isolated offline installation, ESM + require(ESM), public declarations and runtime API passed.\n`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
