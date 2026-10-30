import * as z from "zod";
import { COLLECTOR_SOURCES } from "./collector-source.ts";
import {
	vaultCaptureAuthorizationSchema,
	type VaultCaptureAuthorization,
} from "./vault-policy.ts";

export { COLLECTOR_SOURCES } from "./collector-source.ts";

export const TRACE_EVENT_TYPES = [
	"user_message",
	"assistant_message",
	"tool_call",
	"tool_result",
	"session_meta",
	"task_started",
	"turn_context",
	"compacted",
	"token_usage_record",
	"token_count",
	"world_state",
	"retained_context",
	"security_risk_score",
	"reasoning",
	"agent_reasoning",
	"agent_reasoning_raw_content",
	"todo_list",
	"compaction",
	"context_compaction",
	"configuration_update",
	"additional_tools",
	"task_complete",
	"turn_complete",
	"thread_goal_updated",
	"thread_rolled_back",
	"turn_aborted",
	"thread_settings_applied",
	"source_record",
] as const;

export type CollectorSource = (typeof COLLECTOR_SOURCES)[number];

const COLLECTOR_SOURCE_LABELS: Record<CollectorSource, string> = {
	codex: "Codex",
	claude: "Claude Code",
	cursor: "Cursor",
};

export function collectorSourceLabel(source: CollectorSource): string {
	return COLLECTOR_SOURCE_LABELS[source];
}

export const MAX_TRACE_EVENTS_PER_BATCH = 100;

export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export const cursorBillingRequestSchema = z
	.object({
		conversationId: z.uuid(),
		reconcileFromMs: z.number().int().nonnegative().nullable(),
		events: z
			.array(
				z
					.object({
						timestamp: z.number().int().nonnegative(),
						kind: z.enum([
							"included",
							"paid",
							"byok",
							"not_charged",
							"unknown",
						]),
						inputTokens: z.number().int().nonnegative().nullable(),
						outputTokens: z.number().int().nonnegative().nullable(),
						cacheReadTokens: z.number().int().nonnegative().nullable(),
						cacheWriteTokens: z.number().int().nonnegative().nullable(),
						paidUsd: z.number().finite().nonnegative().nullable(),
					})
					.strict(),
			)
			.max(5000),
	})
	.strict();

export type CursorBillingRequest = z.infer<typeof cursorBillingRequestSchema>;

export function codexCreditSign(value: string): -1 | 0 | 1 {
	const mantissa = value.split(/[eE]/, 1)[0]!;
	if (!/[1-9]/.test(mantissa)) return 0;
	return mantissa.startsWith("-") ? -1 : 1;
}

export const codexBillingRequestSchema = z
	.object({
		accountFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
		reconcile: z.boolean(),
		tasks: z
			.array(
				z
					.object({
						threadId: z.uuid(),
						createdAt: z.iso.datetime().nullable(),
						descendantThreadIds: z.array(z.uuid()).max(900),
						dataStatus: z.enum([
							"available",
							"partial",
							"unavailable",
							"not_queried",
						]),
						usageSource: z.string().max(100),
						balanceUsageCredits: z
							.string()
							.regex(/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/)
							.max(128)
							.nullable(),
					})
					.strict(),
			)
			.max(100),
		authTurns: z
			.array(
				z
					.object({
						threadId: z.uuid(),
						turnId: z.uuid(),
						mode: z.enum(["chatgpt", "api_key", "conflicting"]),
					})
					.strict(),
			)
			.max(5000),
	})
	.strict();

export type CodexBillingRequest = z.infer<typeof codexBillingRequestSchema>;

export type TraceRunMarker =
	| Readonly<{
			kind: "identity";
			id: string;
			parentId: string | null;
			ownStart: boolean;
			startOrdinal: number | null;
	  }>
	| Readonly<{ kind: "start"; sourceOrdinal: number }>;

export type TraceEvent = Readonly<{
	eventId: string;
	sessionId: string;
	sequence: number;
	callId: string | null;
	projectId: string | null;
	occurredAt: string | null;
	eventType: TraceEventType;
	payload: Readonly<Record<string, JsonValue>>;
	run?: TraceRunMarker;
	capture?: VaultCaptureAuthorization;
}>;

export type TraceEventBatch = Readonly<{ events: readonly TraceEvent[] }>;
export type TraceEventAcknowledgement = Readonly<{
	deviceId: string;
	acceptedEventIds: readonly string[];
}>;

export type CollectorEnrollmentRequest = Readonly<{
	deviceName: string;
	organizationId?: string;
	source?: CollectorSource;
}>;

export type CollectorExpansionRequest = Readonly<{
	source: CollectorSource;
	token: string;
	organizationId?: string;
}>;

export type CollectorOrganizationOption = Readonly<{
	id: string;
	name: string;
}>;

export type CollectorEnrollmentResponse =
	| Readonly<{
			status: "enrolled";
			token: string;
			deviceId: string;
			organizationId: string;
			organizationName: string;
	  }>
	| Readonly<{
			status: "choose_organization";
			organizations: readonly CollectorOrganizationOption[];
			hasMore: boolean;
	  }>;

// A collector's import of the sessions saved before it connected. `complete`
// means every listed session was read and every queued event was uploaded.
export type CollectorHistoryProgress = Readonly<{
	sessions: number;
	readSessions: number;
	complete: boolean;
}>;

export type CollectorFrictionSummary = Readonly<{
	weekEpisodes: number;
	dayEpisodes: number;
}>;

export type ParseResult<T> =
	| Readonly<{ success: true; value: T }>
	| Readonly<{ success: false; error: string }>;

const UUID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const unpairedSurrogate = /[\uD800-\uDFFF]/u;

export const traceIdentitySchema = z
	.string()
	.min(1)
	.max(200)
	.refine(
		(value) => !value.includes("\u0000") && !unpairedSurrogate.test(value),
		"Trace identifiers cannot contain NUL or unpaired Unicode surrogates.",
	)
	.describe("Must not contain NUL or unpaired Unicode surrogates.");

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);
const jsonPayloadSchema = z.record(z.string(), jsonValueSchema);
export const runMarkerSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("identity"),
			id: traceIdentitySchema,
			parentId: traceIdentitySchema.nullable(),
			ownStart: z.boolean(),
			startOrdinal: z
				.number()
				.int()
				.min(0)
				.max(Number.MAX_SAFE_INTEGER)
				.nullable(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("start"),
			sourceOrdinal: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		})
		.strict(),
]);
const textPartSchema = z.object({ text: z.string() }).passthrough();
const typedPartSchema = z.object({ type: z.string() }).passthrough();

export function traceReadableText(value: JsonValue | undefined): string | null {
	if (value === null || value === undefined) return null;
	const stringValue = z.string().safeParse(value);
	if (stringValue.success) {
		const trimmed = stringValue.data.trim();
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
			try {
				const parsed = jsonValueSchema.safeParse(JSON.parse(trimmed));
				if (parsed.success) return traceReadableText(parsed.data);
			} catch {
				return stringValue.data;
			}
		}
		return stringValue.data;
	}
	if (Array.isArray(value)) {
		return value.map(traceReadableText).filter(Boolean).join("\n\n");
	}
	const textPart = textPartSchema.safeParse(value);
	if (textPart.success) return traceReadableText(textPart.data.text);
	const typedPart = typedPartSchema.safeParse(value);
	if (typedPart.success && typedPart.data.type.includes("image")) {
		return "[Image attachment]";
	}
	return JSON.stringify(value, null, 2);
}

export const traceEventSchema = z
	.object({
		eventId: traceIdentitySchema,
		sessionId: traceIdentitySchema,
		sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		callId: z.string().max(255).nullable(),
		projectId: z.string().regex(UUID_PATTERN).nullable(),
		occurredAt: z
			.string()
			.regex(TIMESTAMP_PATTERN)
			.refine((value) => !Number.isNaN(Date.parse(value)))
			.describe("Must also be a timestamp accepted by Date.parse.")
			.nullable(),
		eventType: z.enum(TRACE_EVENT_TYPES),
		payload: jsonPayloadSchema,
		run: runMarkerSchema.optional(),
		capture: vaultCaptureAuthorizationSchema.optional(),
	})
	.strict();

export const traceEventBatchSchema = z
	.object({
		events: z.array(traceEventSchema).min(1).max(MAX_TRACE_EVENTS_PER_BATCH),
	})
	.strict()
	.describe("Event IDs must be unique within the batch.");

export const acknowledgementSchema = z
	.object({
		deviceId: z.string().regex(UUID_PATTERN),
		acceptedEventIds: z.array(z.string()),
	})
	.strict()
	.describe(
		"Accepted event IDs must match the submitted batch exactly, without duplicates.",
	);

const episodeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const collectorFrictionSummarySchema = z
	.object({ weekEpisodes: episodeCountSchema, dayEpisodes: episodeCountSchema })
	.strict()
	.refine(
		(summary) => summary.dayEpisodes <= summary.weekEpisodes,
		"The last day cannot have more friction episodes than the last week.",
	)
	.describe("dayEpisodes must not exceed weekEpisodes.");

const sessionCountSchema = z.number().int().min(0).max(1_000_000);
export const collectorHistoryProgressSchema = z
	.object({
		sessions: sessionCountSchema,
		readSessions: sessionCountSchema,
		complete: z.boolean(),
	})
	.strict()
	.refine(
		(progress) => progress.readSessions <= progress.sessions,
		"Read sessions cannot exceed listed sessions.",
	)
	.refine(
		(progress) =>
			!progress.complete || progress.readSessions === progress.sessions,
		"A complete import has read every listed session.",
	)
	.describe(
		"readSessions must not exceed sessions; complete requires equal counts.",
	);

export const collectorEnrollmentRequestSchema = z
	.object({
		deviceName: z
			.string()
			.trim()
			.min(1)
			.max(160)
			.describe("Trimmed before length validation."),
		organizationId: z.string().regex(UUID_PATTERN).optional(),
		source: z.enum(COLLECTOR_SOURCES).optional(),
	})
	.strict();

export const collectorExpansionRequestSchema = z
	.object({
		source: z.enum(COLLECTOR_SOURCES),
		token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
		organizationId: z.string().regex(UUID_PATTERN).optional(),
	})
	.strict();

export const collectorEnrollmentResponseSchema = z.discriminatedUnion(
	"status",
	[
		z
			.object({
				status: z.literal("enrolled"),
				token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
				deviceId: z.string().regex(UUID_PATTERN),
				organizationId: z.string().regex(UUID_PATTERN),
				organizationName: z.string().min(1).max(160),
			})
			.strict(),
		z
			.object({
				status: z.literal("choose_organization"),
				organizations: z
					.array(
						z
							.object({
								id: z.string().regex(UUID_PATTERN),
								name: z.string().min(1).max(160),
							})
							.strict(),
					)
					.max(20),
				hasMore: z.boolean(),
			})
			.strict(),
	],
);

function schemaError(error: z.ZodError, fallback: string): string {
	return error.issues[0]?.message ?? fallback;
}

export function parseTraceEventBatch(
	input: unknown,
): ParseResult<TraceEventBatch> {
	const parsed = traceEventBatchSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			error: schemaError(parsed.error, "Trace event batch is invalid."),
		};
	}
	const eventIds = new Set<string>();
	for (const event of parsed.data.events) {
		if (eventIds.has(event.eventId)) {
			return {
				success: false,
				error: "A batch cannot contain duplicate event ids.",
			};
		}
		eventIds.add(event.eventId);
	}
	return { success: true, value: parsed.data };
}

export function parseTracePayload(
	input: unknown,
): ParseResult<Readonly<Record<string, JsonValue>>> {
	const parsed = jsonPayloadSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			error: schemaError(parsed.error, "Trace payload must be a JSON object."),
		};
	}
	return { success: true, value: parsed.data };
}

export function parseCollectorEnrollmentRequest(
	input: unknown,
): ParseResult<CollectorEnrollmentRequest> {
	const parsed = collectorEnrollmentRequestSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			error: schemaError(
				parsed.error,
				"Collector enrollment request is invalid.",
			),
		};
	}
	return { success: true, value: parsed.data };
}

export function parseCollectorExpansionRequest(
	input: unknown,
): ParseResult<CollectorExpansionRequest> {
	const parsed = collectorExpansionRequestSchema.safeParse(input);
	return parsed.success
		? { success: true, value: parsed.data }
		: { success: false, error: "Collector source is invalid." };
}

export function parseCollectorHistoryProgress(
	input: unknown,
): ParseResult<CollectorHistoryProgress> {
	const parsed = collectorHistoryProgressSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			error: schemaError(
				parsed.error,
				"Collector history progress is invalid.",
			),
		};
	}
	return { success: true, value: parsed.data };
}

export function parseCollectorEnrollmentResponse(
	input: unknown,
): ParseResult<CollectorEnrollmentResponse> {
	const parsed = collectorEnrollmentResponseSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			error: schemaError(
				parsed.error,
				"Collector enrollment response is invalid.",
			),
		};
	}
	return { success: true, value: parsed.data };
}

export function parseTraceEventAcknowledgement(
	input: unknown,
	expectedEventIds: readonly string[],
): ParseResult<TraceEventAcknowledgement> {
	const parsed = acknowledgementSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			error: schemaError(parsed.error, "Acknowledgement has an invalid shape."),
		};
	}
	const { acceptedEventIds } = parsed.data;
	if (acceptedEventIds.length !== expectedEventIds.length) {
		return {
			success: false,
			error: "Acknowledgement event ids do not match the batch.",
		};
	}
	const actual = new Set<string>();
	for (const eventId of acceptedEventIds) {
		if (!expectedEventIds.includes(eventId)) {
			return {
				success: false,
				error: "Acknowledgement includes an unknown event id.",
			};
		}
		actual.add(eventId);
	}
	if (actual.size !== expectedEventIds.length) {
		return {
			success: false,
			error: "Acknowledgement contains duplicate event ids.",
		};
	}
	return {
		success: true,
		value: { ...parsed.data, acceptedEventIds: [...actual] },
	};
}

// The hook and the server both key a repository by its launch directory, and
// the hook's line-oriented files cannot hold a directory with control
// characters. Windows directories include fully qualified drive and UNC paths.
export function isLaunchDirectory(value: string): boolean {
	if (
		!(
			value.startsWith("/") ||
			/^[A-Za-z]:[\\/]/.test(value) ||
			/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)
		) ||
		value.length > 4096
	)
		return false;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export function normalizeWindowsLaunchDirectory(value: string): string | null {
	if (!isLaunchDirectory(value)) return null;
	if (
		!/^[A-Za-z]:[\\/]/.test(value) &&
		!/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)
	)
		return null;
	const normalized = value
		.replaceAll("\\", "/")
		.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
	return /^[A-Z]:\/$/.test(normalized)
		? normalized
		: normalized.replace(/\/+$/, "");
}

export function parseCollectorFrictionSummary(
	input: unknown,
): ParseResult<CollectorFrictionSummary> {
	const parsed = collectorFrictionSummarySchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			error: schemaError(parsed.error, "Friction summary is invalid."),
		};
	}
	return { success: true, value: parsed.data };
}
