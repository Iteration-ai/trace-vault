import assert from "node:assert/strict";
import test from "node:test";
import {
	eventText,
	systemSummary,
	toolArgument,
	toolName,
	traceEventKind,
	traceEventLabel,
} from "./ui-trace-event.js";

test("event labels and kinds cover known and unknown event types", () => {
	assert.equal(traceEventLabel("user_message"), "User message");
	assert.equal(traceEventKind("user_message"), "human");
	assert.equal(traceEventKind("tool_result"), "tool");
	assert.equal(traceEventKind("agent_reasoning"), "reasoning");
	assert.equal(traceEventLabel("future_event"), "future_event");
	assert.equal(traceEventKind("future_event"), "system");
});

test("message text is read from each collector's payload shape", () => {
	assert.equal(eventText({ text: "Claude or Cursor" }), "Claude or Cursor");
	assert.equal(eventText({ type: "user_message", message: "Codex" }), "Codex");
	assert.equal(
		eventText({
			type: "message",
			role: "assistant",
			content: [
				{ type: "output_text", text: "First" },
				{ type: "output_text", text: "Second" },
			],
		}),
		"First\n\nSecond",
	);
	assert.equal(eventText({ type: "function_call_output", output: "ok" }), "ok");
	assert.equal(eventText({ text: "   ", record: {} }), null);
});

test("tool calls show their name and most telling argument", () => {
	const claude = {
		text: null,
		name: "Bash",
		record: {
			message: {
				content: [
					{ type: "text", text: "Running tests" },
					{ type: "tool_use", id: "call-1", input: { command: "pnpm test" } },
				],
			},
		},
	};
	assert.equal(toolName(claude), "Bash");
	assert.equal(toolArgument(claude, "call-1"), "pnpm test");
	assert.equal(toolArgument(claude, "call-2"), null);

	const codex = {
		type: "function_call",
		name: "shell",
		arguments: JSON.stringify({ command: ["bash", "-lc", "rg -n retry src"] }),
	};
	assert.equal(toolArgument(codex, "call-3"), "rg -n retry src");
	assert.equal(
		toolArgument({ name: "apply_patch", arguments: "not json" }, null),
		"not json",
	);

	const cursor = { name: "read_file", input: { path: "app/page.tsx" } };
	assert.equal(toolArgument(cursor, null), "app/page.tsx");
	assert.equal(toolName({ tool_name: "Edit" }), "Edit");
});

test("system records summarize their known fields", () => {
	assert.equal(
		systemSummary("token_usage_record", {
			model: "claude-sonnet-5",
			usage: { input_tokens: 48210, output_tokens: 5357 },
		}),
		`claude-sonnet-5 · ${(48210).toLocaleString()} input · ${(5357).toLocaleString()} output`,
	);
	assert.equal(
		systemSummary("session_meta", {
			cwd: "/work/payments",
			git: { branch: "main" },
		}),
		"/work/payments · main",
	);
	assert.equal(systemSummary("session_meta", {}), null);
});
