import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod";
import {
	parseTraceEventBatch,
	type JsonValue,
	type TraceEvent,
	type TraceEventType,
} from "iteration-trace-contracts";
import { gitRepositoryUrl } from "./git-repository.js";

export type ClaudeParseResult = Readonly<{
	events: readonly TraceEvent[];
	gaps: readonly string[];
}>;

type JsonRecord = Record<string, JsonValue>;

const CONTEXT_RECORD_TYPES = new Set([
	"attachment",
	"system",
	"last-prompt",
	"mode",
	"permission-mode",
	"atis-latch",
	"ai-title",
	"file-history-snapshot",
	"file-history-delta",
	"cost-state",
	"queue-operation",
	"pr-link",
]);

function object(value: unknown): JsonRecord | null {
	const parsed = z.record(z.string(), z.json()).safeParse(value);
	return parsed.success ? parsed.data : null;
}

function string(value: unknown): string | null {
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data : null;
}

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

const URL_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

function childThreadId(parentId: string, agentId: string): string {
	const bytes = createHash("sha1")
		.update(URL_NAMESPACE)
		.update(
			`https://github.com/Thytu/Iteration/claude/${parentId}/agent/${agentId}`,
		)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const SESSION_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claudeSessionIdentity(filename: string): Readonly<{
	sessionId: string;
	parentSessionId: string | null;
	agentId: string | null;
	runId: string;
	parentRunId: string | null;
}> | null {
	if (!filename.endsWith(".jsonl")) return null;
	const basename = path.basename(filename, ".jsonl");
	if (path.basename(path.dirname(filename)) === "subagents") {
		const parent = path.basename(path.dirname(path.dirname(filename)));
		if (!basename.startsWith("agent-") || !SESSION_UUID.test(parent))
			return null;
		const agentId = basename.slice("agent-".length);
		if (agentId.length === 0) return null;
		const threadId = childThreadId(parent, agentId);
		const sessionId = `claude:${threadId}`;
		const runId = `${parent}/agent/${agentId}`;
		if (sessionId.length > 200 || runId.length > 200) return null;
		return {
			sessionId,
			parentSessionId: `claude:${parent}`,
			agentId,
			runId,
			parentRunId: parent,
		};
	}
	const sessionId = `claude:${basename}`;
	return sessionId.length <= 200 && SESSION_UUID.test(basename)
		? {
				sessionId,
				parentSessionId: null,
				agentId: null,
				runId: basename,
				parentRunId: null,
			}
		: null;
}

function timestamp(record: JsonRecord): string | null {
	const value = string(record.timestamp);
	return value !== null &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
			value,
		) &&
		!Number.isNaN(Date.parse(value))
		? value
		: null;
}

function event(
	identity: NonNullable<ReturnType<typeof claudeSessionIdentity>>,
	record: JsonRecord,
	byteOffset: number,
	index: number,
	eventType: TraceEventType,
	payload: JsonRecord,
	callId: string | null = null,
	stableKey?: string,
): TraceEvent {
	return {
		eventId: `${String(index).padStart(4, "0")}:${digest(`${identity.sessionId}:${stableKey ?? string(record.uuid) ?? `${byteOffset}:${JSON.stringify(record)}`}`)}`,
		sessionId: identity.sessionId,
		sequence: byteOffset,
		callId,
		projectId: null,
		occurredAt: timestamp(record),
		eventType,
		payload,
	};
}

function contentText(value: unknown): string | null {
	const literal = string(value);
	if (literal !== null) return literal;
	if (!Array.isArray(value)) return null;
	const parts = value.flatMap((part) => {
		const block = object(part);
		const text = block === null ? null : string(block.text);
		return text === null ? [] : [text];
	});
	return parts.length > 0 ? parts.join("\n") : null;
}

export function parseClaudeLine(
	line: string,
	filename: string,
	byteOffset: number,
	repositoryUrl: (cwd: string) => string | null = gitRepositoryUrl,
): ClaudeParseResult {
	const identity = claudeSessionIdentity(filename);
	if (identity === null)
		return { events: [], gaps: ["invalid_claude_session_path"] };
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return { events: [], gaps: ["malformed_jsonl_record"] };
	}
	const record = object(decoded);
	if (record === null) return { events: [], gaps: ["record_is_not_an_object"] };
	const recordType = string(record.type);
	const identityGap = () => {
		const sourceSessionId = string(record.sessionId);
		if (
			(identity.agentId !== null && sourceSessionId === null) ||
			(sourceSessionId !== null &&
				`claude:${sourceSessionId}` !==
					(identity.parentSessionId ?? identity.sessionId))
		) {
			return "session_id_does_not_match_path";
		}
		if (
			identity.agentId !== null &&
			string(record.agentId) !== identity.agentId
		)
			return "agent_id_does_not_match_path";
		return null;
	};
	const gap = identityGap();
	if (gap !== null) return { events: [], gaps: [gap] };
	const gaps: string[] = [];
	if (record.timestamp !== undefined && timestamp(record) === null)
		gaps.push("invalid_source_timestamp");
	const events: TraceEvent[] = [];
	// Every record repeats the session's identity under one event ID, so the
	// first record that knows the working directory describes the launch.
	const cwd = string(record.cwd);
	if (cwd !== null) {
		const meta = {
			id: identity.runId,
			parent_thread_id: identity.parentRunId,
			cwd,
			git: {
				branch: string(record.gitBranch),
				repository_url: repositoryUrl(cwd),
			},
			version: string(record.version),
			agentId: identity.agentId,
		};
		events.push({
			...event(
				identity,
				record,
				0,
				0,
				"session_meta",
				meta,
				null,
				"session_meta",
			),
			run: {
				kind: "identity",
				id: identity.runId,
				parentId: identity.parentRunId,
				ownStart: true,
				startOrdinal: null,
			},
		});
	}
	const appendUserMessage = () => {
		const message = object(record.message);
		const content = message === null ? null : string(message.content);
		if (message === null) gaps.push("user_without_message");
		else if (content !== null) {
			events.push(
				event(identity, record, byteOffset, 1, "user_message", {
					text: content,
					record,
				}),
			);
		} else if (Array.isArray(message.content)) {
			for (const [index, value] of message.content.entries()) {
				const block = object(value);
				if (block === null) {
					gaps.push("invalid_user_content_block");
					continue;
				}
				if (block.type === "tool_result") {
					const callId = string(block.tool_use_id);
					if (callId === null) {
						gaps.push("tool_result_without_call_id");
						continue;
					}
					events.push(
						event(
							identity,
							record,
							byteOffset,
							index + 1,
							"tool_result",
							{
								text: contentText(block.content),
								record,
							},
							callId,
						),
					);
				} else {
					events.push(
						event(identity, record, byteOffset, index + 1, "user_message", {
							text: string(block.text) ?? contentText(block.content),
							record,
						}),
					);
				}
			}
		} else gaps.push("unsupported_user_content");
	};
	const appendAssistantMessage = () => {
		const message = object(record.message);
		if (message === null || !Array.isArray(message.content))
			gaps.push("assistant_without_content_blocks");
		else {
			for (const [index, value] of message.content.entries()) {
				const block = object(value);
				if (block === null) {
					gaps.push("invalid_assistant_content_block");
					continue;
				}
				const blockType = string(block.type);
				const eventType =
					blockType === "text"
						? "assistant_message"
						: blockType === "thinking" || blockType === "redacted_thinking"
							? "reasoning"
							: blockType === "tool_use"
								? "tool_call"
								: null;
				if (eventType === null) {
					gaps.push(`unsupported_assistant_block:${blockType ?? "unknown"}`);
					continue;
				}
				const callId = eventType === "tool_call" ? string(block.id) : null;
				if (eventType === "tool_call" && callId === null) {
					gaps.push("tool_call_without_call_id");
					continue;
				}
				events.push(
					event(
						identity,
						record,
						byteOffset,
						index + 1,
						eventType,
						{
							text: string(block.text) ?? string(block.thinking),
							name: string(block.name),
							record,
						},
						callId,
					),
				);
			}
			if (object(message.usage) !== null && string(message.id) !== null) {
				events.push(
					event(
						identity,
						record,
						byteOffset,
						9999,
						"token_usage_record",
						{ model: string(message.model), usage: message.usage as JsonValue },
						null,
						`usage:${message.id}`,
					),
				);
			}
		}
	};
	if (recordType === "user") appendUserMessage();
	else if (recordType === "assistant") appendAssistantMessage();
	else if (recordType !== null && CONTEXT_RECORD_TYPES.has(recordType)) {
		const attachment = object(record.attachment);
		events.push(
			event(identity, record, byteOffset, 1, "source_record", {
				sourceType: recordType,
				subtype:
					string(record.subtype) ??
					(attachment === null ? null : string(attachment.type)),
				record,
			}),
		);
	} else gaps.push(`unsupported_claude_record:${recordType ?? "unknown"}`);
	const valid: TraceEvent[] = [];
	for (const candidate of events) {
		const checked = parseTraceEventBatch({ events: [candidate] });
		if (checked.success) valid.push(candidate);
		else gaps.push(`invalid_normalized_event:${candidate.eventType}`);
	}
	return { events: valid, gaps };
}

export function parseClaudeGitHookLine(
	line: string,
	filename: string,
): ClaudeParseResult {
	const name = path.basename(filename, ".jsonl");
	if (
		!SESSION_UUID.test(name) ||
		path.basename(path.dirname(filename)) !== "git-queue"
	)
		return { events: [], gaps: ["invalid_claude_git_hook_path"] };
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return { events: [], gaps: ["malformed_claude_git_hook_record"] };
	}
	const parsed = z
		.object({
			sessionId: z.uuid(),
			cwd: z.string().min(1),
			capturedAt: z.iso.datetime(),
			git: z.object({
				branch: z.string().nullable(),
				repository_url: z.string().nullable(),
			}),
		})
		.safeParse(decoded);
	if (!parsed.success || !path.isAbsolute(parsed.data.cwd))
		return { events: [], gaps: ["invalid_claude_git_hook_record"] };
	const { sessionId, cwd, git, capturedAt } = parsed.data;
	const candidate: TraceEvent = {
		eventId: `hook:${digest(filename)}`,
		sessionId: `claude:${sessionId}`,
		sequence: 1,
		callId: null,
		projectId: null,
		occurredAt: capturedAt,
		eventType: "session_meta",
		payload: { id: sessionId, cwd, git },
		run: {
			kind: "identity",
			id: sessionId,
			parentId: null,
			ownStart: true,
			startOrdinal: null,
		},
	};
	return parseTraceEventBatch({ events: [candidate] }).success
		? { events: [candidate], gaps: [] }
		: { events: [], gaps: ["invalid_claude_git_hook_record"] };
}
