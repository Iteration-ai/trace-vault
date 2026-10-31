import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	PgSchema,
	primaryKey,
	text,
	timestamp,
	uuid,
	type ExtraConfigColumn,
	type IndexBuilder,
} from "drizzle-orm/pg-core";
import {
	TRACE_EVENT_TYPES,
	type JsonValue,
	type TraceRunMarker,
} from "iteration-trace-contracts";

const timestamptz = (name: string) =>
	timestamp(name, { withTimezone: true, mode: "date" });
const traceEventTypeList = TRACE_EVENT_TYPES.map((type) => {
	if (!/^[a-z0-9_]+$/.test(type)) throw new Error("Invalid trace event type.");
	return `'${type}'`;
}).join(", ");

export function traceEventColumns() {
	return {
		organizationId: uuid("organization_id").notNull(),
		projectId: uuid("project_id"),
		deviceId: uuid("device_id").notNull(),
		userId: uuid("user_id").notNull(),
		eventId: text("event_id").notNull(),
		sessionId: text("session_id").notNull(),
		sequence: bigint("sequence", { mode: "number" }).notNull(),
		callId: text("call_id"),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "string",
		}),
		eventType: text("event_type").notNull(),
		payload: jsonb("payload")
			.$type<Readonly<Record<string, JsonValue>>>()
			.notNull(),
		run: jsonb("run").$type<TraceRunMarker>(),
		displayText: text("display_text"),
		isInstruction: boolean("is_instruction").notNull().default(false),
		toolName: text("tool_name"),
		exitCode: integer("exit_code"),
		model: text("model"),
		contextWindow: bigint("context_window", { mode: "number" }),
		totalTokens: bigint("total_tokens", { mode: "number" }),
		usageAt: timestamptz("usage_at"),
		usageInputTokens: bigint("usage_input_tokens", { mode: "number" }),
		usageCacheReadTokens: bigint("usage_cache_read_tokens", { mode: "number" }),
		usageCacheWriteTokens: bigint("usage_cache_write_tokens", {
			mode: "number",
		}),
		usageCacheWriteLongTokens: bigint("usage_cache_write_long_tokens", {
			mode: "number",
		}),
		usageOutputTokens: bigint("usage_output_tokens", { mode: "number" }),
		pullRequestUrl: text("pull_request_url"),
		toolFailed: boolean("tool_failed"),
		runId: text("thread_id"),
		parentRunId: text("parent_thread_id"),
		isRunStart: boolean("is_run_start").notNull().default(false),
		runStartOrdinal: bigint("run_start_ordinal", { mode: "number" }),
		agentPath: text("agent_path"),
		agentNickname: text("agent_nickname"),
		launchCwd: text("launch_cwd"),
		launchBranch: text("launch_branch"),
		launchRepositoryUrl: text("launch_repository_url"),
		launchCommitHash: text("launch_commit_hash"),
		ingestedAt: timestamptz("ingested_at").notNull().defaultNow(),
	};
}

export function traceSessionColumns() {
	return {
		organizationId: uuid("organization_id").notNull(),
		deviceId: uuid("device_id").notNull(),
		userId: uuid("user_id").notNull(),
		sessionId: text("session_id").notNull(),
		eventCount: bigint("event_count", { mode: "number" }).notNull(),
		runId: text("thread_id"),
		parentRunId: text("parent_thread_id"),
		ownStartSequence: bigint("own_start_sequence", { mode: "number" }),
		ownEventCount: bigint("own_event_count", { mode: "number" })
			.notNull()
			.default(0),
		agentPath: text("agent_path"),
		agentNickname: text("agent_nickname"),
		agentDescription: text("agent_description"),
		userMessagePreview: text("user_message_preview"),
		sourceTitle: text("source_title"),
		sourceCwd: text("source_cwd"),
		sourceRepositoryUrl: text("source_repository_url"),
		firstUserMessagePreview: text("first_user_message_preview"),
		launchCwd: text("launch_cwd"),
		launchBranch: text("launch_branch"),
		launchRepositoryUrl: text("launch_repository_url"),
		launchCommitHash: text("launch_commit_hash"),
		firstOccurredAt: timestamptz("first_occurred_at"),
		lastOccurredAt: timestamptz("last_occurred_at"),
		firstReceivedAt: timestamptz("first_received_at").notNull(),
		lastReceivedAt: timestamptz("last_received_at").notNull(),
	};
}

export function traceSessionDeletionColumns() {
	return {
		organizationId: uuid("organization_id").notNull(),
		userId: uuid("user_id").notNull(),
		sessionId: text("session_id").notNull(),
		deletedAt: timestamptz("deleted_at").notNull().defaultNow(),
	};
}

type EventColumns = {
	[K in keyof ReturnType<typeof traceEventColumns>]: ExtraConfigColumn;
};
type SessionColumns = {
	[K in keyof ReturnType<typeof traceSessionColumns>]: ExtraConfigColumn;
};
type DeletionColumns = {
	[K in keyof ReturnType<
		typeof traceSessionDeletionColumns
	>]: ExtraConfigColumn;
};

export type TraceIndexOptions = Readonly<{ concurrently?: boolean }>;

function withConcurrency(
	builder: IndexBuilder,
	options: TraceIndexOptions,
): IndexBuilder {
	return options.concurrently === false ? builder : builder.concurrently();
}

/** Host foreign keys are deliberately supplied by the host's table declaration. */
export function traceEventConstraints(
	table: EventColumns,
	options: TraceIndexOptions = {},
) {
	return [
		primaryKey({
			name: "trace_events_pkey",
			columns: [table.deviceId, table.eventId],
		}),
		check("trace_events_sequence_nonnegative", sql`${table.sequence} >= 0`),
		check(
			"trace_events_event_id_length",
			sql`char_length(${table.eventId}) BETWEEN 1 AND 200`,
		),
		check(
			"trace_events_session_id_length",
			sql`char_length(${table.sessionId}) BETWEEN 1 AND 200`,
		),
		check(
			"trace_events_call_id_length",
			sql`${table.callId} IS NULL OR char_length(${table.callId}) <= 255`,
		),
		check(
			"trace_events_payload_object",
			sql`jsonb_typeof(${table.payload}) = 'object'`,
		),
		check(
			"trace_events_type",
			sql`${table.eventType} IN (${sql.raw(traceEventTypeList)})`,
		),
		index("trace_events_session_order").on(
			table.organizationId,
			table.deviceId,
			table.sessionId,
			table.sequence,
		),
		index("trace_events_session_metadata")
			.on(
				table.organizationId,
				table.deviceId,
				table.sessionId,
				table.sequence,
				table.eventId,
			)
			.where(
				sql`${table.eventType} = 'session_meta' OR ${table.runId} IS NOT NULL OR ${table.isRunStart}`,
			),
		withConcurrency(
			index("trace_events_message_occurred").on(
				table.organizationId,
				table.eventType,
				table.occurredAt,
			),
			options,
		).where(sql`${table.occurredAt} IS NOT NULL`),
		withConcurrency(
			index("trace_events_message_received").on(
				table.organizationId,
				table.eventType,
				table.ingestedAt,
			),
			options,
		).where(sql`${table.ingestedAt} IS NOT NULL`),
		index("trace_events_user_message_order")
			.on(
				table.organizationId,
				table.deviceId,
				table.sessionId,
				table.sequence,
				table.eventId,
			)
			.where(sql`${table.eventType} = 'user_message'`),
		index("trace_events_organization_received").on(
			table.organizationId,
			table.ingestedAt,
		),
		index("trace_events_user_session").on(
			table.organizationId,
			table.userId,
			table.sessionId,
		),
		index("trace_events_usage_time")
			.on(table.organizationId, table.usageAt)
			.where(sql`${table.usageAt} IS NOT NULL`),
		index("trace_events_usage_cost")
			.on(
				table.organizationId,
				table.deviceId,
				table.sessionId,
				table.usageAt,
				table.model,
				table.usageInputTokens,
				table.usageCacheReadTokens,
				table.usageCacheWriteTokens,
				table.usageCacheWriteLongTokens,
				table.usageOutputTokens,
			)
			.where(sql`${table.usageAt} IS NOT NULL`),
		index("trace_events_usage_session")
			.on(table.organizationId, table.deviceId, table.sessionId, table.usageAt)
			.where(sql`${table.usageAt} IS NOT NULL`),
		index("trace_events_turn_context")
			.on(
				table.organizationId,
				table.deviceId,
				table.sessionId,
				sql`(${table.payload}->>'turn_id')`,
			)
			.where(sql`${table.eventType} = 'turn_context'`),
		index("trace_events_usage_order")
			.on(table.organizationId, table.deviceId, table.sessionId, table.sequence)
			.where(sql`${table.usageAt} IS NOT NULL`),
		index("trace_events_usage_without_model")
			.on(
				table.organizationId,
				table.deviceId,
				table.sessionId,
				sql`(${table.payload}->>'turn_id')`,
			)
			.where(sql`${table.usageAt} IS NOT NULL AND ${table.model} IS NULL`),
		index("trace_events_pull_request")
			.on(table.organizationId, table.deviceId, table.sessionId)
			.where(sql`${table.pullRequestUrl} IS NOT NULL`),
		index("trace_events_claude_agent_result")
			.on(
				table.organizationId,
				table.deviceId,
				table.sessionId,
				sql`(${table.payload}#>>'{record,toolUseResult,agentId}')`,
			)
			.where(
				sql`${table.eventType} = 'tool_result' AND (${table.payload}#>>'{record,toolUseResult,agentId}') IS NOT NULL`,
			),
	];
}

export function traceSessionConstraints(
	table: SessionColumns,
	options: TraceIndexOptions = {},
) {
	return [
		primaryKey({
			name: "trace_sessions_pkey",
			columns: [table.organizationId, table.deviceId, table.sessionId],
		}),
		check("trace_sessions_event_count_positive", sql`${table.eventCount} > 0`),
		check(
			"trace_sessions_session_id_length",
			sql`char_length(${table.sessionId}) BETWEEN 1 AND 200`,
		),
		withConcurrency(
			index("trace_sessions_occurred_time").on(
				table.organizationId,
				table.lastOccurredAt,
			),
			options,
		).where(sql`${table.lastOccurredAt} IS NOT NULL`),
		index("trace_sessions_recent").on(
			table.organizationId,
			table.lastReceivedAt.desc(),
			table.deviceId,
			table.sessionId,
		),
		index("trace_sessions_user_recent").on(
			table.organizationId,
			table.userId,
			table.lastReceivedAt.desc(),
			table.deviceId,
			table.sessionId,
		),
		index("trace_sessions_first_received").on(
			table.organizationId,
			table.firstReceivedAt,
		),
		index("trace_sessions_user_session").on(
			table.organizationId,
			table.userId,
			table.sessionId,
		),
		index("trace_sessions_thread").on(
			table.organizationId,
			table.userId,
			table.deviceId,
			table.runId,
		),
		index("trace_sessions_parent_thread").on(
			table.organizationId,
			table.userId,
			table.deviceId,
			table.parentRunId,
		),
	];
}

export function traceSessionDeletionConstraints(table: DeletionColumns) {
	return [
		primaryKey({
			name: "trace_session_deletions_pkey",
			columns: [table.organizationId, table.userId, table.sessionId],
		}),
		check(
			"trace_session_deletions_session_id_length",
			sql`char_length(${table.sessionId}) BETWEEN 1 AND 200`,
		),
	];
}

export function bindTraceTables(
	schema: string,
	options: TraceIndexOptions = {},
) {
	assertTraceSchema(schema);
	// pgSchema("public") rejects the default namespace, but an explicit binding
	// must remain qualified even when the caller changes its search_path.
	const table = new PgSchema(schema).table;
	return {
		traceEvents: table("trace_events", traceEventColumns(), (columns) =>
			traceEventConstraints(columns, options),
		),
		traceSessions: table("trace_sessions", traceSessionColumns(), (columns) =>
			traceSessionConstraints(columns, options),
		),
		traceSessionDeletions: table(
			"trace_session_deletions",
			traceSessionDeletionColumns(),
			traceSessionDeletionConstraints,
		),
	};
}

export function assertTraceSchema(schema: string): void {
	if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_")) {
		throw new Error("An explicit non-system PostgreSQL schema is required.");
	}
}
