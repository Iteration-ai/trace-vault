import assert from "node:assert/strict";
import test from "node:test";
import {
	codexBillingRequestSchema,
	codexCreditSign,
} from "iteration-trace-contracts";
import { groupCodexTasks, parseCodexAuthLog } from "./codex-billing.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const GRANDCHILD = "33333333-3333-4333-8333-333333333333";
const TURN = "44444444-4444-4444-8444-444444444444";

test("only current-account local roots collect their own descendants", () => {
	const tasks = groupCodexTasks(
		[
			{
				threadId: ROOT,
				parentThreadId: null,
				createdAt: "2026-09-28T10:00:00.000Z",
				accountId: "account-1",
				modelProvider: "openai",
				mtimeMs: 100,
			},
			{
				threadId: CHILD,
				parentThreadId: ROOT,
				createdAt: null,
				accountId: null,
				modelProvider: "openai",
				mtimeMs: 200,
			},
			{
				threadId: GRANDCHILD,
				parentThreadId: CHILD,
				createdAt: null,
				accountId: null,
				modelProvider: "openai",
				mtimeMs: 300,
			},
			{
				threadId: "55555555-5555-4555-8555-555555555555",
				parentThreadId: null,
				createdAt: null,
				accountId: "account-2",
				modelProvider: "openai",
				mtimeMs: 400,
			},
		],
		"account-1",
	);
	assert.deepEqual(tasks, [
		{
			threadId: ROOT,
			createdAt: "2026-09-28T10:00:00.000Z",
			descendantThreadIds: [CHILD, GRANDCHILD],
			mtimeMs: 300,
		},
	]);
});

test("Codex sampling logs identify the auth mode for a saved turn", () => {
	assert.deepEqual(
		parseCodexAuthLog(
			ROOT,
			`session_loop{thread_id=${ROOT}}:try_run_sampling_request{turn_id=${TURN} model=gpt-6}: auth_mode=Some(Chatgpt)`,
		),
		{ threadId: ROOT, turnId: TURN, mode: "chatgpt" },
	);
	assert.deepEqual(
		parseCodexAuthLog(
			ROOT,
			`try_run_sampling_request{turn_id=${TURN} model=gpt-6}: auth_mode=Some(ApiKey)`,
		),
		{ threadId: ROOT, turnId: TURN, mode: "api_key" },
	);
	assert.equal(
		parseCodexAuthLog(
			ROOT,
			`try_run_sampling_request{turn_id=${TURN}}: auth_mode=None`,
		),
		null,
	);
});

test("Codex task credits preserve scientific-notation zero and exact sign", () => {
	for (const [credits, sign] of [
		["0E-10", 0],
		["-0.000000000000000000", 0],
		["1.2E-9", 1],
		["-1.2E-9", -1],
	] as const)
		assert.equal(codexCreditSign(credits), sign);
	assert.equal(
		codexBillingRequestSchema.safeParse({
			accountFingerprint: "a".repeat(64),
			reconcile: true,
			tasks: [
				{
					threadId: ROOT,
					createdAt: null,
					descendantThreadIds: [],
					dataStatus: "available",
					usageSource: "included_plan",
					balanceUsageCredits: "0E-10",
				},
			],
			authTurns: [],
		}).success,
		true,
	);
});
