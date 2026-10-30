import { createHash } from "node:crypto";
import path from "node:path";
import {
	type JsonValue,
	parseTracePayload,
	type TraceEvent,
	type TraceEventType,
	type TraceRunMarker,
} from "iteration-trace-contracts";
import * as z from "zod";

export type RolloutParseResult =
	| Readonly<{ kind: "event"; event: TraceEvent }>
	| Readonly<{ kind: "ignored" }>
	| Readonly<{ kind: "gap"; reason: string }>;

const recordSchema = z.record(z.string(), z.unknown());

const CONTEXT_RECORDS = [
	"session_meta",
	"turn_context",
	"compacted",
	"token_usage_record",
	"world_state",
	"retained_context",
	"security_risk_score",
] as const satisfies readonly TraceEventType[];

const RESPONSE_CONTEXT_TYPES = [
	"reasoning",
	"todo_list",
	"compaction",
	"context_compaction",
	"configuration_update",
	"additional_tools",
] as const satisfies readonly TraceEventType[];

const EVENT_CONTEXT_TYPES = [
	"task_complete",
	"task_started",
	"turn_complete",
	"token_count",
	"thread_goal_updated",
	"thread_rolled_back",
	"turn_aborted",
	"thread_settings_applied",
	"agent_reasoning",
	"agent_reasoning_raw_content",
] as const satisfies readonly TraceEventType[];

const COMPLETED_CONTEXT_TYPES = [
	"reasoning",
	"todo_list",
] as const satisfies readonly TraceEventType[];

const IGNORED_EVENT_MESSAGES = ["turn_started"] as const;

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
	const parsed = recordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function parseJsonString(value: unknown): string | null {
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data : null;
}

function oneOf<T extends string>(
	value: string | null,
	allowed: readonly T[],
): value is T {
	return value !== null && (allowed as readonly string[]).includes(value);
}

const sourceOrdinalSchema = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER);

function sourceOrdinal(value: unknown): number | null {
	const parsed = sourceOrdinalSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function sessionFromPath(filename: string): string {
	const basename = path.basename(filename, ".jsonl");
	return basename.startsWith("rollout-")
		? basename.slice("rollout-".length)
		: basename;
}

function callIdFrom(record: Record<string, unknown>): string | null {
	return (
		parseJsonString(record.call_id) ?? parseJsonString(record.tool_call_id)
	);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function safePayload(
	value: unknown,
): Readonly<Record<string, JsonValue>> | null {
	try {
		const normalized: unknown = JSON.parse(JSON.stringify(value));
		const parsed = parseTracePayload(normalized);
		return parsed.success ? parsed.value : null;
	} catch {
		return null;
	}
}

function eventTimestamp(record: Record<string, unknown>): string | null {
	const timestamp = parseJsonString(record.timestamp);
	return timestamp !== null && !Number.isNaN(Date.parse(timestamp))
		? timestamp
		: null;
}

function capturedEvent(
	record: Record<string, unknown>,
	filename: string,
	byteOffset: number,
	eventType: TraceEventType,
	payload: Record<string, unknown>,
	callId: string | null,
	run?: TraceRunMarker,
): RolloutParseResult {
	const eventPayload = safePayload(payload);
	if (eventPayload === null)
		return { kind: "gap", reason: `invalid_${eventType}_payload` };
	const sessionId = sessionFromPath(filename);
	return {
		kind: "event",
		event: {
			eventId: sha256(`${sessionId}:${byteOffset}`),
			sessionId,
			sequence: byteOffset,
			callId,
			projectId: null,
			occurredAt: eventTimestamp(record),
			eventType,
			payload: eventPayload,
			...(run === undefined ? {} : { run }),
		},
	};
}

function mapResponseItem(
	payload: Record<string, unknown>,
): Readonly<{ eventType: TraceEventType; callId: string | null }> | null {
	const type = parseJsonString(payload.type);
	if (type === "message") {
		const role = parseJsonString(payload.role);
		if (role === "user") return { eventType: "user_message", callId: null };
		if (role === "assistant")
			return { eventType: "assistant_message", callId: null };
		return null;
	}
	if (type === "agent_message") {
		return { eventType: "assistant_message", callId: null };
	}
	if (oneOf(type, RESPONSE_CONTEXT_TYPES)) {
		return { eventType: type, callId: null };
	}
	if (
		oneOf(type, [
			"function_call",
			"custom_tool_call",
			"mcp_tool_call",
			"web_search_call",
			"tool_search_call",
			"image_generation_call",
			"local_shell_call",
		])
	) {
		return { eventType: "tool_call", callId: callIdFrom(payload) };
	}
	if (
		oneOf(type, [
			"function_call_output",
			"custom_tool_call_output",
			"mcp_tool_call_output",
			"web_search_output",
			"tool_search_output",
		])
	) {
		return { eventType: "tool_result", callId: callIdFrom(payload) };
	}
	return null;
}

function mapCompletedItem(
	item: Record<string, unknown>,
): Readonly<{ eventType: TraceEventType; callId: string | null }> | null {
	const type = parseJsonString(item.type);
	if (
		oneOf(type, [
			"command_execution",
			"mcp_tool_call",
			"collab_tool_call",
			"web_search",
			"file_change",
		])
	) {
		return { eventType: "tool_result", callId: callIdFrom(item) };
	}
	if (type === "agent_message") {
		return { eventType: "assistant_message", callId: null };
	}
	if (oneOf(type, COMPLETED_CONTEXT_TYPES)) {
		return { eventType: type, callId: null };
	}
	return null;
}

export function parseRolloutLine(
	line: string,
	filename: string,
	byteOffset: number,
): RolloutParseResult {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return { kind: "gap", reason: "malformed_jsonl_record" };
	}
	const record = parseJsonRecord(decoded);
	if (record === null)
		return { kind: "gap", reason: "record_is_not_an_object" };
	const recordType = parseJsonString(record.type);
	const payload = parseJsonRecord(record.payload);
	if (oneOf(recordType, CONTEXT_RECORDS)) {
		if (payload === null)
			return { kind: "gap", reason: `${recordType}_without_payload` };
		let run: TraceRunMarker | undefined;
		if (
			recordType === "session_meta" &&
			parseJsonString(payload.id) === sessionFromPath(filename).slice(-36)
		) {
			const source = parseJsonRecord(payload.source);
			const subagent =
				source === null ? null : parseJsonRecord(source.subagent);
			const spawn =
				subagent === null ? null : parseJsonRecord(subagent.thread_spawn);
			const parentId =
				parseJsonString(payload.parent_thread_id) ??
				(spawn === null ? null : parseJsonString(spawn.parent_thread_id));
			const startOrdinal = sourceOrdinal(
				payload.subagent_history_start_ordinal,
			);
			run = {
				kind: "identity",
				id: sessionFromPath(filename).slice(-36),
				parentId,
				ownStart: parentId === null,
				startOrdinal,
			};
		}
		return capturedEvent(
			record,
			filename,
			byteOffset,
			recordType,
			payload,
			null,
			run,
		);
	}
	if (recordType === "response_item" && payload !== null) {
		const mapped = mapResponseItem(payload);
		if (mapped === null) {
			const payloadType = parseJsonString(payload.type) ?? "unknown";
			return {
				kind: "gap",
				reason: `unsupported_response_item:${payloadType}`,
			};
		}
		return capturedEvent(
			record,
			filename,
			byteOffset,
			mapped.eventType,
			payload,
			mapped.callId,
		);
	}
	if (recordType === "event_msg" && payload !== null) {
		return parseEventMessage(record, payload, filename, byteOffset);
	}
	return {
		kind: "gap",
		reason: `unsupported_rollout_record:${recordType ?? "unknown"}`,
	};
}

function parseEventMessage(
	record: Record<string, unknown>,
	payload: Record<string, unknown>,
	filename: string,
	byteOffset: number,
): RolloutParseResult {
	const messageType = parseJsonString(payload.type);
	if (messageType === "user_message") {
		return capturedEvent(
			record,
			filename,
			byteOffset,
			"user_message",
			payload,
			null,
		);
	}
	if (messageType === "agent_message") {
		return capturedEvent(
			record,
			filename,
			byteOffset,
			"assistant_message",
			payload,
			null,
		);
	}
	if (
		oneOf(messageType, [
			"mcp_tool_call_end",
			"web_search_end",
			"image_generation_end",
			"patch_apply_end",
		])
	) {
		return capturedEvent(
			record,
			filename,
			byteOffset,
			"tool_result",
			payload,
			callIdFrom(payload),
		);
	}
	if (oneOf(messageType, IGNORED_EVENT_MESSAGES)) return { kind: "ignored" };
	if (oneOf(messageType, EVENT_CONTEXT_TYPES)) {
		const ordinal = sourceOrdinal(record.ordinal);
		const run: TraceRunMarker | undefined =
			messageType === "thread_settings_applied" &&
			parseJsonString(payload.thread_id) ===
				sessionFromPath(filename).slice(-36) &&
			ordinal !== null
				? { kind: "start", sourceOrdinal: ordinal }
				: undefined;
		return capturedEvent(
			record,
			filename,
			byteOffset,
			messageType,
			payload,
			null,
			run,
		);
	}
	if (messageType !== "item_completed") {
		return {
			kind: "gap",
			reason: `unsupported_event_message:${messageType ?? "unknown"}`,
		};
	}
	const item = parseJsonRecord(payload.item);
	if (item === null)
		return { kind: "gap", reason: "item_completed_without_item" };
	const mapped = mapCompletedItem(item);
	if (mapped === null) {
		const itemType = parseJsonString(item.type) ?? "unknown";
		return { kind: "gap", reason: `unsupported_completed_item:${itemType}` };
	}
	return capturedEvent(
		record,
		filename,
		byteOffset,
		mapped.eventType,
		item,
		mapped.callId,
	);
}
