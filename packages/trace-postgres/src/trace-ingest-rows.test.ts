import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceEvent } from "iteration-trace-contracts";
import { prepareTraceIngestRows } from "./trace-ingest-rows.js";

test("receipt provenance belongs to the winning original event, before storage normalization", () => {
	const original: TraceEvent = {
		eventId: "usage",
		sessionId: "session",
		sequence: 1,
		callId: null,
		projectId: null,
		occurredAt: "2025-01-01T00:00:00Z",
		eventType: "token_usage_record",
		payload: { usage: { output_tokens: 1 } },
	};
	const winner: TraceEvent = {
		...original,
		sequence: 2,
		projectId: "original-native-text-id",
		occurredAt: "2025-02-01T00:00:00Z",
		payload: { usage: { output_tokens: 9 }, text: "before\u0000after" },
		capture: {
			revision: 1,
			basis: "repository",
			reference: "github.com/synthetic/test",
		},
	};
	const prepared = prepareTraceIngestRows({
		events: [original, winner, original],
	});
	assert.equal(prepared.events[0], winner);
	assert.equal(prepared.events[0]?.projectId, "original-native-text-id");
	assert.equal(prepared.events[0]?.occurredAt, "2025-02-01T00:00:00Z");
	assert.deepEqual(prepared.events[0]?.capture, winner.capture);
	assert.equal(prepared.events[0]?.payload.text, "before\u0000after");
	assert.equal(prepared.rows[0]?.payload.text, String.raw`before\u0000after`);
	assert.deepEqual(prepared.acceptedEventIds, ["usage", "usage", "usage"]);
});
