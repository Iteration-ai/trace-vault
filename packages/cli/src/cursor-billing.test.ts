import assert from "node:assert/strict";
import test from "node:test";
import {
	cursorConversationIds,
	normalizeCursorUsageEvent,
	planCursorBillingSync,
} from "./cursor-billing.js";

const local = new Set(["44444444-4444-4444-8444-444444444444"]);

test("real Cursor transcript UUIDs are eligible for billing lookup", () => {
	assert.deepEqual(
		[
			...cursorConversationIds([
				"/projects/agent-transcripts/44444444-4444-4444-8444-444444444444/44444444-4444-4444-8444-444444444444.jsonl",
				"/projects/agent-transcripts/not-a-uuid/not-a-uuid.jsonl",
			]),
		],
		["44444444-4444-4444-8444-444444444444"],
	);
});

test("Cursor included events stay included even when Cursor reports positive charged cents", () => {
	const result = normalizeCursorUsageEvent(
		{
			conversationId: "44444444-4444-4444-8444-444444444444",
			timestamp: "1790476577634",
			kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
			chargedCents: 10.068,
			usageBasedCosts: "-",
			tokenUsage: {
				inputTokens: 18650,
				outputTokens: 104,
				cacheReadTokens: 24832,
				totalCents: 10.068,
			},
		},
		local,
	);
	assert.equal(result?.event.kind, "included");
	assert.equal(result?.event.paidUsd, null);
	assert.equal(result?.event.timestamp, 1790476577634);
	assert.equal(result?.event.cacheWriteTokens, 0);
});

test("account events outside local project transcripts are discarded", () => {
	const result = normalizeCursorUsageEvent(
		{
			conversationId: "55555555-5555-4555-8555-555555555555",
			timestamp: "1790476577634",
			kind: "USAGE_EVENT_KIND_USAGE_BASED",
			usageBasedCosts: "$0.04",
		},
		local,
	);
	assert.equal(result, null);
});

test("Cursor billing history is fetched once, then only bounded windows are revisited", () => {
	const day = 24 * 60 * 60 * 1000;
	const now = Date.parse("2026-09-28T12:00:00.000Z");
	const accountFingerprint = "a".repeat(64);
	assert.deepEqual(planCursorBillingSync(null, accountFingerprint, now), {
		mode: "history",
		startDateMs: 0,
		reconcileFromMs: null,
	});
	const state = {
		accountFingerprint,
		lastSyncedAtMs: now - 6 * 60 * 60 * 1000,
		lastAuditAtMs: now - 6 * day,
	};
	assert.deepEqual(planCursorBillingSync(state, accountFingerprint, now), {
		mode: "recent",
		startDateMs: now - 8 * day,
		reconcileFromMs: now - 7 * day,
	});
	assert.deepEqual(
		planCursorBillingSync(
			{ ...state, lastAuditAtMs: now - 8 * day },
			accountFingerprint,
			now,
		),
		{
			mode: "audit",
			startDateMs: now - 36 * day,
			reconcileFromMs: now - 35 * day,
		},
	);
	assert.deepEqual(
		planCursorBillingSync(
			{
				...state,
				lastSyncedAtMs: now - 60 * day,
				lastAuditAtMs: now - 60 * day,
			},
			accountFingerprint,
			now,
		),
		{
			mode: "audit",
			startDateMs: now - 61 * day,
			reconcileFromMs: now - 60 * day,
		},
	);
	assert.equal(
		planCursorBillingSync(state, "b".repeat(64), now).mode,
		"history",
	);
});
