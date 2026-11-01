import {
	TRACE_EVENT_TYPES,
	type TraceEventType,
} from "iteration-trace-contracts";
import { z } from "zod";

const TRACE_EVENT_LABELS = {
	user_message: "User message",
	assistant_message: "Assistant message",
	tool_call: "Tool call",
	tool_result: "Tool result",
	session_meta: "Session metadata",
	task_started: "Turn started",
	turn_context: "Turn context",
	compacted: "Compacted history",
	token_usage_record: "Token usage",
	token_count: "Token count",
	world_state: "World state",
	retained_context: "Retained context",
	security_risk_score: "Security risk",
	reasoning: "Reasoning",
	agent_reasoning: "Reasoning",
	agent_reasoning_raw_content: "Raw reasoning",
	todo_list: "Plan",
	compaction: "Compaction",
	context_compaction: "Context compaction",
	configuration_update: "Configuration update",
	additional_tools: "Additional tools",
	task_complete: "Task complete",
	turn_complete: "Turn complete",
	thread_goal_updated: "Thread goal",
	thread_rolled_back: "Thread rolled back",
	turn_aborted: "Turn aborted",
	thread_settings_applied: "Thread settings",
	source_record: "Source record",
} as const satisfies Record<TraceEventType, string>;

export type TraceEventKind =
	| "human"
	| "agent"
	| "tool"
	| "reasoning"
	| "system";

const TRACE_EVENT_KINDS = {
	user_message: "human",
	assistant_message: "agent",
	tool_call: "tool",
	tool_result: "tool",
	additional_tools: "tool",
	reasoning: "reasoning",
	agent_reasoning: "reasoning",
	agent_reasoning_raw_content: "reasoning",
	todo_list: "reasoning",
	session_meta: "system",
	task_started: "system",
	turn_context: "system",
	compacted: "system",
	token_usage_record: "system",
	token_count: "system",
	world_state: "system",
	retained_context: "system",
	security_risk_score: "system",
	compaction: "system",
	context_compaction: "system",
	configuration_update: "system",
	task_complete: "system",
	turn_complete: "system",
	thread_goal_updated: "system",
	thread_rolled_back: "system",
	turn_aborted: "system",
	thread_settings_applied: "system",
	source_record: "system",
} as const satisfies Record<TraceEventType, TraceEventKind>;

function knownType(eventType: string): TraceEventType | null {
	return (TRACE_EVENT_TYPES as readonly string[]).includes(eventType)
		? (eventType as TraceEventType)
		: null;
}

// Stored events keep their original type, so an unknown one stays readable.
export function traceEventLabel(eventType: string): string {
	const known = knownType(eventType);
	return known ? TRACE_EVENT_LABELS[known] : eventType;
}

export function traceEventKind(eventType: string): TraceEventKind {
	const known = knownType(eventType);
	return known ? TRACE_EVENT_KINDS[known] : "system";
}

type Payload = Record<string, unknown>;

// Payloads keep each source's original shape, so every field is parsed where
// it is read and anything unexpected reads as absent.
const payloadSchema = z.record(z.string(), z.unknown());
const textSchema = z.string().refine((value) => value.trim() !== "");
const listSchema = z.array(z.unknown());
const countSchema = z.number();

function record(value: unknown): Payload | null {
	const parsed = payloadSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function text(value: unknown): string | null {
	const parsed = textSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function texts(value: unknown): string[] {
	const list = listSchema.safeParse(value);
	return list.success
		? list.data.flatMap((part) => {
				const found = text(part);
				return found === null ? [] : [found];
			})
		: [];
}

function contentText(value: unknown): string | null {
	const direct = text(value);
	if (direct !== null) return direct;
	const list = listSchema.safeParse(value);
	if (!list.success) return null;
	const parts = list.data.flatMap((part) => {
		const found = text(record(part)?.text) ?? text(part);
		return found === null ? [] : [found];
	});
	return parts.length ? parts.join("\n\n") : null;
}

// Collectors keep each source's own payload shape: Claude Code and Cursor
// carry `text`, Codex carries `message`, content blocks or tool `output`.
export function eventText(payload: Payload): string | null {
	return (
		text(payload.text) ??
		text(payload.message) ??
		contentText(payload.content) ??
		text(payload.output) ??
		null
	);
}

export function toolName(payload: Payload): string | null {
	return text(payload.name) ?? text(payload.tool_name);
}

const argumentKeys = [
	"command",
	"cmd",
	"file_path",
	"path",
	"pattern",
	"query",
	"url",
	"description",
	"prompt",
	"input",
] as const;

function commandText(value: unknown): string | null {
	const direct = text(value);
	if (direct !== null) return direct;
	const parts = texts(value);
	// Codex wraps commands as ["bash", "-lc", "<script>"].
	if (parts.length === 3 && /^-l?c$/.test(parts[1] ?? "")) return parts[2]!;
	return parts.length ? parts.join(" ") : null;
}

function inputSummary(input: unknown): string | null {
	const value = record(input);
	if (!value) return text(input);
	for (const key of argumentKeys) {
		const found = commandText(value[key]);
		if (found) return found;
	}
	return null;
}

function claudeToolInput(payload: Payload, callId: string | null): unknown {
	const blocks = listSchema.safeParse(
		record(record(payload.record)?.message)?.content,
	);
	if (!blocks.success) return null;
	const block = blocks.data
		.map(record)
		.find((item) => item?.type === "tool_use" && item.id === callId);
	return block?.input ?? null;
}

export function toolArgument(
	payload: Payload,
	callId: string | null,
): string | null {
	if (payload.input !== undefined) return inputSummary(payload.input);
	const encoded = z.string().safeParse(payload.arguments);
	if (encoded.success) {
		try {
			return inputSummary(JSON.parse(encoded.data));
		} catch {
			return text(encoded.data);
		}
	}
	return inputSummary(claudeToolInput(payload, callId));
}

function count(value: unknown): number | null {
	const parsed = countSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

// A one-line summary for system records whose payload has a known shape.
export function systemSummary(
	eventType: string,
	payload: Payload,
): string | null {
	if (eventType === "token_usage_record") {
		const usage = record(payload.usage);
		const input = count(usage?.input_tokens);
		const output = count(usage?.output_tokens);
		return [
			text(payload.model),
			input === null ? null : `${input.toLocaleString()} input`,
			output === null ? null : `${output.toLocaleString()} output`,
		]
			.filter(Boolean)
			.join(" · ");
	}
	if (eventType === "session_meta") {
		const git = record(payload.git);
		return (
			[text(payload.cwd), text(git?.branch)].filter(Boolean).join(" · ") || null
		);
	}
	if (eventType === "source_record")
		return [text(payload.sourceType), text(payload.subtype)]
			.filter(Boolean)
			.join(" · ");
	return eventText(payload);
}
