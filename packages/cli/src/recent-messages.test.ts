import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { TraceEvent } from "iteration-trace-contracts";
import { collectorTick, scanSourceOnce } from "./collector.js";
import type { CollectorFetcher } from "./collector-fetch.js";
import {
	type CollectorConfig,
	collectorPaths,
	nextBatch,
	prepareSourceInitialState,
	saveState,
} from "./storage.js";

const SESSIONS = [
	"11111111-2222-4333-8444-000000000001",
	"11111111-2222-4333-8444-000000000002",
	"11111111-2222-4333-8444-000000000003",
];

function record(
	sessionId: string,
	type: "user" | "assistant",
	text: string,
	uuid: string,
) {
	return {
		type,
		sessionId,
		uuid,
		timestamp: "2026-10-01T00:00:00Z",
		message:
			type === "user"
				? { role: "user", content: text }
				: { role: "assistant", content: [{ type: "text", text }] },
	};
}

// Three Claude sessions, the last one modified most recently, each holding
// two messages from the person and one reply.
async function fixture(context: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "recent-messages-"));
	context.after(() => fs.rm(root, { recursive: true, force: true }));
	const home = path.join(root, "claude");
	const directory = path.join(root, "collector");
	for (const [index, sessionId] of SESSIONS.entries()) {
		const filename = path.join(home, "projects", "p", `${sessionId}.jsonl`);
		await fs.mkdir(path.dirname(filename), { recursive: true });
		const records = [
			record(sessionId, "user", `ask ${index}`, `${sessionId}-a`),
			record(sessionId, "assistant", `reply ${index}`, `${sessionId}-b`),
			record(sessionId, "user", `again ${index}`, `${sessionId}-c`),
		];
		await fs.writeFile(
			filename,
			`${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
		);
		const modified = new Date(Date.UTC(2026, 9, 1 + index));
		await fs.utimes(filename, modified, modified);
	}
	const paths = collectorPaths(directory);
	await saveState(await prepareSourceInitialState("claude", home, true), paths);
	const config: CollectorConfig = {
		endpoint: "https://iteration.example/api/traces/ingest",
		token: "token",
		dataDirectory: directory,
		source: "claude",
		claudeHome: home,
	};
	const batches: TraceEvent[][] = [];
	const fetcher: CollectorFetcher = async (_input, init) => {
		const events = (JSON.parse(String(init?.body)) as { events: TraceEvent[] })
			.events;
		batches.push(events);
		return new Response(
			JSON.stringify({
				deviceId: "22222222-2222-4333-8444-555555555555",
				acceptedEventIds: events.map((event) => event.eventId),
			}),
			{ status: 202, headers: { "content-type": "application/json" } },
		);
	};
	return { config, paths, batches, fetcher };
}

function texts(events: readonly TraceEvent[]): string[] {
	return events.map(
		(event) =>
			`${event.eventType}:${(event.payload as { text?: string }).text}`,
	);
}

test("the person's newest messages upload before the rest of their history", async (context) => {
	const f = await fixture(context);
	const result = await collectorTick(
		f.config,
		f.paths,
		f.fetcher,
		undefined,
		undefined,
		{ recentMessages: 3 },
	);
	assert.deepEqual(texts(f.batches[0] ?? []), [
		"user_message:ask 2",
		"user_message:again 2",
		"user_message:ask 1",
	]);
	assert.deepEqual(result.recentMessages, { sent: 3, complete: true });
	const later = f.batches.slice(1).flatMap(texts);
	assert.ok(later.includes("assistant_message:reply 2"));
	assert.ok(later.includes("user_message:ask 0"));
});

test("a history with fewer messages than the limit completes once all of it is sent", async (context) => {
	const f = await fixture(context);
	const result = await collectorTick(
		f.config,
		f.paths,
		f.fetcher,
		undefined,
		undefined,
		{ recentMessages: 50 },
	);
	assert.deepEqual(result.recentMessages, { sent: 6, complete: true });
	const again = await collectorTick(
		f.config,
		f.paths,
		f.fetcher,
		undefined,
		undefined,
		{ recentMessages: 50 },
	);
	assert.deepEqual(again.recentMessages, { sent: 6, complete: true });
});

test("messages the main scan already queued go first and count toward the limit", async (context) => {
	const f = await fixture(context);
	await scanSourceOnce(f.config, f.paths);
	const busy: CollectorFetcher = async () =>
		new Response("{}", { status: 429, headers: { "retry-after": "5" } });
	const waiting = await collectorTick(
		f.config,
		f.paths,
		busy,
		undefined,
		undefined,
		{ recentMessages: 2 },
	);
	assert.deepEqual(waiting.recentMessages, { sent: 0, complete: false });
	const result = await collectorTick(
		f.config,
		f.paths,
		f.fetcher,
		undefined,
		undefined,
		{ recentMessages: 2 },
	);
	assert.deepEqual(texts(f.batches[0] ?? []).slice(0, 2), [
		"user_message:ask 2",
		"user_message:again 2",
	]);
	assert.deepEqual(result.recentMessages, { sent: 2, complete: true });
});

test("without a priority, the next batch keeps queue order", async (context) => {
	const f = await fixture(context);
	await scanSourceOnce(f.config, f.paths);
	const ordered = await nextBatch(f.paths, 3 * 1024 * 1024);
	const reply = ordered.find(
		(event) => event.eventType === "assistant_message",
	);
	assert.ok(reply);
	const first = await nextBatch(
		f.paths,
		3 * 1024 * 1024,
		new Set([reply.eventId]),
	);
	assert.equal(first[0]?.eventId, reply.eventId);
	assert.deepEqual(
		first.slice(1).map((event) => event.eventId),
		ordered
			.filter((event) => event.eventId !== reply.eventId)
			.map((event) => event.eventId),
	);
});

test("vault collection refuses to send recent messages first", async (context) => {
	const f = await fixture(context);
	await assert.rejects(
		collectorTick(
			{ ...f.config, destination: "vault" },
			f.paths,
			f.fetcher,
			undefined,
			undefined,
			{ recentMessages: 3 },
		),
		/Vault collection does not send recent messages first/,
	);
});
