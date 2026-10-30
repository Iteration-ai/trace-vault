import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod";
import {
	parseTraceEventBatch,
	type JsonValue,
	type TraceEvent,
	type TraceEventType,
} from "iteration-trace-contracts";

type RecordValue = Record<string, JsonValue>;
type ParseResult = Readonly<{
	events: readonly TraceEvent[];
	gaps: readonly string[];
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): RecordValue | null {
	const parsed = z.record(z.string(), z.json()).safeParse(value);
	return parsed.success ? parsed.data : null;
}

function string(value: unknown): string | null {
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data : null;
}

function nonnegativeInteger(value: unknown): number | null {
	const parsed = z
		.number()
		.int()
		.min(0)
		.max(Number.MAX_SAFE_INTEGER)
		.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function event(
	conversationId: string,
	filename: string,
	byteOffset: number,
	index: number,
	eventType: TraceEventType,
	payload: RecordValue,
	callId: string | null = null,
	occurredAt: string | null = null,
): TraceEvent {
	const hash = createHash("sha256")
		.update(`${filename}:${byteOffset}:${index}:${eventType}`)
		.digest("hex");
	return {
		eventId: `${String(index).padStart(4, "0")}:${hash}`,
		sessionId: `cursor:${conversationId}`,
		sequence: byteOffset * 1000 + index,
		callId,
		projectId: null,
		occurredAt,
		eventType,
		payload,
	};
}

export function parseCursorTranscriptLine(
	line: string,
	filename: string,
	byteOffset: number,
): ParseResult {
	const conversationId = path.basename(filename, ".jsonl");
	if (
		!UUID.test(conversationId) ||
		path.basename(path.dirname(filename)) !== conversationId
	)
		return { events: [], gaps: ["invalid_cursor_transcript_path"] };
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return { events: [], gaps: ["malformed_jsonl_record"] };
	}
	const source = record(decoded);
	if (source === null) return { events: [], gaps: ["record_is_not_an_object"] };
	const events: TraceEvent[] = [];
	const gaps: string[] = [];
	if (byteOffset === 0) {
		events.push({
			...event(conversationId, filename, 0, 0, "session_meta", {
				id: conversationId,
				transcript_path: filename,
			}),
			run: {
				kind: "identity",
				id: conversationId,
				parentId: null,
				ownStart: true,
				startOrdinal: null,
			},
		});
	}
	const appendMessage = (role: "user" | "assistant") => {
		const message = record(source.message);
		if (message === null || !Array.isArray(message.content))
			gaps.push("cursor_message_without_content");
		else {
			for (const [index, value] of message.content.entries()) {
				const block = record(value);
				if (block === null) {
					gaps.push("invalid_cursor_content_block");
					continue;
				}
				const type = string(block.type);
				const eventType =
					type === "tool_use"
						? "tool_call"
						: type === "thinking"
							? "reasoning"
							: type === "text"
								? role === "user"
									? "user_message"
									: "assistant_message"
								: "source_record";
				events.push(
					event(
						conversationId,
						filename,
						byteOffset,
						index + 1,
						eventType,
						{
							text: string(block.text) ?? string(block.thinking),
							name: string(block.name),
							input: block.input ?? null,
							sourceType: type,
							record: source,
						},
						string(block.id),
					),
				);
				if (type !== "text" && type !== "tool_use" && type !== "thinking")
					gaps.push(`unsupported_cursor_content_block:${type ?? "unknown"}`);
			}
		}
	};
	const role = string(source.role);
	if (role === "user" || role === "assistant") appendMessage(role);
	else if (source.type === "turn_ended") {
		events.push(
			event(
				conversationId,
				filename,
				byteOffset,
				1,
				source.status === "success" ? "turn_complete" : "turn_aborted",
				{ record: source },
			),
		);
	} else {
		gaps.push(`unsupported_cursor_record:${string(source.type) ?? "unknown"}`);
		events.push(
			event(conversationId, filename, byteOffset, 1, "source_record", {
				sourceType: string(source.type),
				record: source,
			}),
		);
	}
	return validated(events, gaps);
}

export function parseCursorHookLine(
	line: string,
	filename: string,
): ParseResult {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return { events: [], gaps: ["malformed_cursor_hook_record"] };
	}
	const wrapper = record(decoded);
	const input = wrapper === null ? null : record(wrapper.input);
	const conversationId = input === null ? null : string(input.conversation_id);
	const hook = wrapper === null ? null : string(wrapper.hook);
	const capturedAt = wrapper === null ? null : string(wrapper.capturedAt);
	if (wrapper?.kind === "subagent_transcript_chunk") {
		return parseSubagentChunk(
			wrapper,
			input,
			conversationId,
			capturedAt,
			filename,
		);
	}
	if (
		input === null ||
		conversationId === null ||
		!UUID.test(conversationId) ||
		hook === null ||
		capturedAt === null ||
		Number.isNaN(Date.parse(capturedAt))
	)
		return { events: [], gaps: ["invalid_cursor_hook_record"] };
	return parseHookEvents(
		wrapper!,
		input,
		conversationId,
		hook,
		capturedAt,
		filename,
	);
}

function parseSubagentChunk(
	wrapper: RecordValue,
	input: RecordValue | null,
	conversationId: string | null,
	capturedAt: string | null,
	filename: string,
): ParseResult {
	const subagent = record(wrapper.subagent);
	const part = nonnegativeInteger(subagent?.part);
	const totalParts = nonnegativeInteger(subagent?.totalParts);
	if (
		conversationId === null ||
		!UUID.test(conversationId) ||
		capturedAt === null ||
		Number.isNaN(Date.parse(capturedAt)) ||
		subagent === null ||
		part === null ||
		totalParts === null ||
		part < 1 ||
		part > totalParts ||
		string(subagent.base64) === null
	)
		return { events: [], gaps: ["invalid_cursor_subagent_transcript_chunk"] };
	const transcriptBytes = nonnegativeInteger(wrapper.transcriptBytes) ?? 0;
	const candidate = event(
		conversationId,
		filename,
		transcriptBytes,
		part,
		"source_record",
		{
			sourceType: "cursor_subagent_transcript",
			text: string(subagent.text),
			base64: string(subagent.base64)!,
			path: string(subagent.path),
			part,
			totalParts,
			parent_conversation_id: string(input?.parent_conversation_id),
			subagent_id: string(input?.subagent_id),
		},
		null,
		capturedAt,
	);
	const hash = candidate.eventId.split(":").at(-1)!;
	return validated(
		[
			{
				...candidate,
				sequence: transcriptBytes * 1000 + 500,
				eventId: `${String(Date.parse(capturedAt)).padStart(13, "0")}:${String(2000 + part).padStart(4, "0")}:${hash}`,
			},
		],
		[],
	);
}

function parseHookEvents(
	wrapper: RecordValue,
	input: RecordValue,
	conversationId: string,
	hook: string,
	capturedAt: string,
	filename: string,
): ParseResult {
	const transcriptBytes = wrapper?.transcriptBytes;
	const sequence = nonnegativeInteger(transcriptBytes) ?? 0;
	const events: TraceEvent[] = [];
	if (hook === "beforeSubmitPrompt" || hook === "sessionStart") {
		const roots = Array.isArray(input.workspace_roots)
			? input.workspace_roots
			: [];
		const git = record(wrapper?.git);
		events.push({
			...event(
				conversationId,
				filename,
				sequence,
				0,
				"session_meta",
				{
					id: conversationId,
					cwd: string(roots[0]),
					git: {
						branch: string(git?.branch),
						repository_url: string(git?.repository_url),
					},
					version: string(input.cursor_version),
					model: string(input.model),
					transcript_path: string(input.transcript_path),
				},
				null,
				capturedAt,
			),
			run: {
				kind: "identity",
				id: conversationId,
				parentId: null,
				ownStart: true,
				startOrdinal: null,
			},
		});
	}
	const rawText = JSON.stringify(input);
	if (Buffer.byteLength(rawText, "utf8") <= 500_000) {
		events.push(
			event(
				conversationId,
				filename,
				sequence,
				1,
				"source_record",
				{
					sourceType: `cursor_hook:${hook}`,
					record: input,
				},
				null,
				capturedAt,
			),
		);
	} else {
		const chunks = splitText(rawText);
		for (const [index, text] of chunks.entries())
			events.push(
				event(
					conversationId,
					filename,
					sequence,
					index + 1,
					"source_record",
					{
						sourceType: `cursor_hook:${hook}`,
						text,
						part: index + 1,
						totalParts: chunks.length,
					},
					null,
					capturedAt,
				),
			);
	}
	const appendHookPayload = () => {
		const next = events.length + 1;
		if (hook === "preToolUse") {
			events.push(
				event(
					conversationId,
					filename,
					sequence,
					next,
					"tool_call",
					{
						name: string(input.tool_name),
						input: input.tool_input ?? null,
					},
					string(input.tool_use_id),
					capturedAt,
				),
			);
		}
		if (hook === "postToolUse" || hook === "postToolUseFailure") {
			const output = hookToolOutput(input);
			const chunks = output === null ? [null] : splitText(output);
			for (const [index, text] of chunks.entries())
				events.push(
					event(
						conversationId,
						filename,
						sequence,
						next + index,
						"tool_result",
						{
							text,
							name: string(input.tool_name),
							part: index + 1,
							totalParts: chunks.length,
						},
						string(input.tool_use_id),
						capturedAt,
					),
				);
		} else if (hook === "afterAgentThought") {
			events.push(
				event(
					conversationId,
					filename,
					sequence,
					next,
					"reasoning",
					{
						text: string(input.text) ?? string(input.thought),
					},
					null,
					capturedAt,
				),
			);
		} else if (
			hook === "afterAgentResponse" &&
			(input.usage !== undefined ||
				input.input_tokens !== undefined ||
				input.output_tokens !== undefined)
		) {
			events.push(
				event(
					conversationId,
					filename,
					sequence,
					next,
					"token_usage_record",
					{
						model: string(input.model),
						usage: input.usage ?? {
							input_tokens: input.input_tokens ?? null,
							output_tokens: input.output_tokens ?? null,
							cache_read_tokens: input.cache_read_tokens ?? null,
							cache_write_tokens: input.cache_write_tokens ?? null,
						},
					},
					null,
					capturedAt,
				),
			);
		}
	};
	appendHookPayload();
	const capturedAtMs = Date.parse(capturedAt);
	const ordered = events.map((candidate, index) => {
		const digest = candidate.eventId.split(":").at(-1)!;
		const thought =
			candidate.eventType === "reasoning"
				? createHash("sha256")
						.update(
							`${conversationId}:${string(input.generation_id)?.slice(0, 36) ?? ""}:${candidate.payload.text}`,
						)
						.digest("hex")
				: null;
		return {
			...candidate,
			sequence: sequence * 1000 + 500,
			eventId:
				thought === null
					? `${String(capturedAtMs).padStart(13, "0")}:${String(index).padStart(4, "0")}:${digest}`
					: `thought:${thought}`,
		};
	});
	return validated(ordered, []);
}

function hookToolOutput(input: RecordValue): string | null {
	return (
		string(input.tool_output) ??
		string(input.error_message) ??
		string(input.error) ??
		(input.tool_output === undefined && input.error === undefined
			? null
			: JSON.stringify(input.tool_output ?? input.error))
	);
}

function splitText(value: string): string[] {
	if (value.length === 0) return [""];
	const chunks: string[] = [];
	for (let start = 0; start < value.length; ) {
		let end = Math.min(start + 250_000, value.length);
		if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!))
			end -= 1;
		chunks.push(value.slice(start, end));
		start = end;
	}
	return chunks;
}

function validated(events: readonly TraceEvent[], gaps: string[]): ParseResult {
	const valid: TraceEvent[] = [];
	for (const candidate of events) {
		if (parseTraceEventBatch({ events: [candidate] }).success)
			valid.push(candidate);
		else gaps.push(`invalid_normalized_event:${candidate.eventType}`);
	}
	return { events: valid, gaps };
}
