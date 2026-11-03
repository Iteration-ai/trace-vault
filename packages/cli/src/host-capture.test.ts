import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectorTick, type HostCapturePolicy } from "./collector.js";
import {
	collectorPaths,
	nextBatch,
	prepareSourceInitialState,
	saveState,
	type CollectorConfig,
} from "./storage.js";
import { captureRecordLocation } from "./vault-scope.js";
import type { TraceEvent } from "iteration-trace-contracts";

test("host approval gates both recent messages and the main outbox, and a new revision drops stale queued content", async (context) => {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "host-capture-")),
	);
	context.after(() => fs.rm(root, { recursive: true, force: true }));
	const home = path.join(root, "claude");
	const directory = path.join(root, "collector");
	const approved = path.join(root, "work");
	const privateFolder = path.join(root, "private");
	const sessionId = "11111111-2222-4333-8444-555555555555";
	const filename = path.join(home, "projects", "p", `${sessionId}.jsonl`);
	await fs.mkdir(path.dirname(filename), { recursive: true });
	await fs.writeFile(
		filename,
		[
			{
				type: "user",
				sessionId,
				uuid: "one",
				cwd: approved,
				message: { role: "user", content: "approved request" },
			},
			{
				type: "user",
				sessionId,
				uuid: "two",
				cwd: privateFolder,
				message: { role: "user", content: "private request" },
			},
		]
			.map((record) => JSON.stringify(record))
			.join("\n") + "\n",
	);
	const paths = collectorPaths(directory);
	await saveState(await prepareSourceInitialState("claude", home, true), paths);
	const config: CollectorConfig = {
		source: "claude",
		claudeHome: home,
		dataDirectory: directory,
		endpoint: "https://host.example/traces",
		token: "fixture",
		destination: "host",
	};
	await assert.rejects(
		collectorTick(config, paths),
		/requires a current capture policy/,
	);
	const policy = (
		revision: number,
		allowed: string | null,
	): HostCapturePolicy => ({
		revision,
		authorizeRecord: (source, line, file, cwds) => {
			const location = captureRecordLocation(source, line, file, cwds);
			return location !== null && location === allowed
				? { revision, basis: "location", reference: location }
				: null;
		},
		authorizeEvent: (event) =>
			event.capture?.revision === revision &&
			event.capture.reference === allowed
				? event
				: null,
	});
	const queued: TraceEvent[] = [];
	await collectorTick(
		config,
		paths,
		async (_input, init) => {
			queued.push(
				...(JSON.parse(String(init?.body)) as { events: TraceEvent[] }).events,
			);
			return new Response("unavailable", { status: 503 });
		},
		undefined,
		undefined,
		{ recentMessages: 10, capture: policy(1, approved) },
	).catch((error: unknown) => assert.match(String(error), /503/));
	assert.ok(queued.length > 0);
	assert.ok(queued.every((event) => event.capture?.reference === approved));
	assert.ok(
		!JSON.stringify(await nextBatch(paths, 1024 * 1024)).includes(
			"private request",
		),
	);
	let uploaded = false;
	await collectorTick(
		config,
		paths,
		async () => {
			uploaded = true;
			throw new Error("Unexpected upload");
		},
		undefined,
		undefined,
		{ recentMessages: 10, capture: policy(2, null) },
	);
	assert.equal(uploaded, false);
	assert.deepEqual(await nextBatch(paths, 1024 * 1024), []);
});

test("native locations require current evidence and resolve symlinks before host routing", async (context) => {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "host-location-")),
	);
	context.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(path.join(root, "private"));
	await fs.symlink(path.join(root, "private"), path.join(root, "alias"));
	const cwds: Record<string, string> = {};
	const filename = path.join(root, "session.jsonl");
	assert.equal(
		captureRecordLocation(
			"codex",
			JSON.stringify({
				type: "turn_context",
				payload: { cwd: path.join(root, "alias") },
			}),
			filename,
			cwds,
		),
		path.join(root, "private"),
	);
	assert.equal(
		captureRecordLocation(
			"codex",
			JSON.stringify({ type: "event_msg", payload: { type: "user_message" } }),
			filename,
			cwds,
		),
		path.join(root, "private"),
	);
	assert.equal(captureRecordLocation("codex", "invalid", filename, cwds), null);
	assert.equal(
		captureRecordLocation(
			"codex",
			JSON.stringify({ type: "event_msg", payload: { type: "user_message" } }),
			filename,
			cwds,
		),
		null,
	);
});
