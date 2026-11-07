import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceEvent } from "iteration-trace-contracts";
import {
	packTracePayloads,
	readTracePayload,
	readTracePayloadObject,
} from "./external-payloads.js";

const context = {
	organizationId: "11111111-1111-4111-8111-111111111111",
	userId: "22222222-2222-4222-8222-222222222222",
	deviceId: "33333333-3333-4333-8333-333333333333",
	source: "codex",
} as const;

function event(
	eventId: string,
	sessionId: string,
	sequence: number,
	eventType: TraceEvent["eventType"],
	payload: TraceEvent["payload"],
): TraceEvent {
	return {
		eventId,
		sessionId,
		sequence,
		callId: null,
		projectId: null,
		occurredAt: "2026-01-01T00:00:00.000Z",
		eventType,
		payload,
	};
}

const events = [
	event("b", "session-1", 2, "assistant_message", { text: "second" }),
	event("a", "session-1", 1, "user_message", { text: "first\u0000" }),
	event("c", "session-2", 1, "tool_call", { name: "exec", input: "ls" }),
	event("usage", "session-1", 3, "token_usage_record", {
		usage: { output_tokens: 3 },
	}),
];

test("each session's payloads pack into one object, one gzip member per event", () => {
	const { objects, locations } = packTracePayloads(context, { events });
	assert.equal(objects.length, 2);
	assert.equal(locations.has("usage"), false);
	for (const object of objects)
		assert.match(
			object.key,
			/^11111111-1111-4111-8111-111111111111\/33333333-3333-4333-8333-333333333333\/[0-9a-f]{64}\/[0-9a-f]{64}\.jsonl\.gz$/,
		);
	const first = locations.get("a")!;
	const second = locations.get("b")!;
	assert.equal(first.object, second.object);
	assert.equal(first.offset, 0);
	assert.equal(second.offset, first.length);
	const body = objects.find((object) => object.key === first.object)!.body;
	assert.deepEqual(
		readTracePayload(
			body.subarray(second.offset, second.offset + second.length),
		),
		{ text: "second" },
	);
	// Stored as PostgreSQL would store it: NUL escaped, never dropped.
	assert.deepEqual(readTracePayloadObject(body), [
		{ text: "first\\u0000" },
		{ text: "second" },
	]);
});

test("a retried batch packs to the same keys, and changed contents to new ones", () => {
	const first = packTracePayloads(context, { events });
	const retried = packTracePayloads(context, {
		events: [...events].reverse(),
	});
	assert.deepEqual(
		retried.objects.map((object) => object.key).sort(),
		first.objects.map((object) => object.key).sort(),
	);
	const changed = packTracePayloads(context, {
		events: [event("a", "session-1", 1, "user_message", { text: "other" })],
	});
	assert.notEqual(
		changed.locations.get("a")!.object,
		first.locations.get("a")!.object,
	);
});
