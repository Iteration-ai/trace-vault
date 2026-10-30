import { sql } from "drizzle-orm";
import {
	TRACE_EVENT_TYPES,
	type TraceEventBatch,
} from "iteration-trace-contracts";
import * as z from "zod";
import type {
	TraceIngestChanges,
	TraceIngestExtension,
	TraceStorageContext,
	TraceTransaction,
} from "./contracts.js";
import { assertTraceSchema } from "./schema.js";
import { prepareTraceIngestRows } from "./trace-ingest-rows.js";

const turnReference = z.object({ turn_id: z.string().min(1) });
const changedEvent = z.object({
	organizationId: z.uuid(),
	deviceId: z.uuid(),
	eventId: z.string(),
	sessionId: z.string(),
	sequence: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	eventType: z.enum(TRACE_EVENT_TYPES),
	inserted: z.boolean(),
	ingestedAt: z.string(),
});

/** The host authenticates and validates projects before calling in its transaction. */
export async function ingestTraceBatch<TTransaction extends TraceTransaction>(
	transaction: TTransaction,
	schema: string,
	context: TraceStorageContext,
	batch: TraceEventBatch,
	extension?: TraceIngestExtension<TTransaction>,
	receivedAtByEventId?: ReadonlyMap<string, string>,
): Promise<TraceIngestChanges> {
	assertTraceSchema(schema);
	const events = sql`${sql.identifier(schema)}.${sql.identifier("trace_events")}`;
	const deletions = sql`${sql.identifier(schema)}.${sql.identifier("trace_session_deletions")}`;
	const activity = sql`${sql.identifier(schema)}.${sql.identifier("trace_usage_activity")}`;
	const { rows, sessionIds, acceptedEventIds } = prepareTraceIngestRows(batch);
	const receivedRows = rows.map((row) => {
		const receivedAt = receivedAtByEventId?.get(row.event_id);
		return {
			...row,
			ingested_at:
				receivedAt === undefined ? null : z.iso.datetime().parse(receivedAt),
		};
	});
	const sessionLockKeys = sessionIds.map(
		(id) => `${context.organizationId}:${context.userId}:${id}`,
	);
	await transaction.execute(sql`
		SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
		FROM jsonb_array_elements_text(${JSON.stringify(sessionLockKeys)}::jsonb) AS lock_key
	`);
	const changed = await transaction.execute(sql`
		INSERT INTO ${events} AS stored (
			organization_id, project_id, device_id, user_id, event_id,
			session_id, sequence, call_id, occurred_at, event_type, payload, run, ingested_at
		)
		SELECT ${context.organizationId}::uuid, e.project_id, ${context.deviceId}::uuid, ${context.userId}::uuid,
			e.event_id, e.session_id, e.sequence, e.call_id, e.occurred_at, e.event_type, e.payload, e.run, coalesce(e.ingested_at, now())
		FROM jsonb_to_recordset(${JSON.stringify(receivedRows)}::jsonb) AS e(
			event_id text, session_id text, sequence bigint, call_id text,
			project_id uuid, occurred_at timestamptz, event_type text, payload jsonb, run jsonb, ingested_at timestamptz
		)
		WHERE NOT EXISTS (
			SELECT 1 FROM ${deletions} AS deleted
			WHERE deleted.organization_id = ${context.organizationId}::uuid
				AND deleted.user_id = ${context.userId}::uuid AND deleted.session_id = e.session_id
		)
		ON CONFLICT (device_id, event_id) DO UPDATE SET
			payload = EXCLUDED.payload, sequence = EXCLUDED.sequence, occurred_at = EXCLUDED.occurred_at,
			billing_kind = NULL, billing_paid_usd = NULL
		WHERE stored.event_type = 'token_usage_record'
			AND EXCLUDED.event_type = 'token_usage_record' AND stored.session_id = EXCLUDED.session_id
			AND (EXCLUDED.usage_output_tokens > coalesce(stored.usage_output_tokens, -1)
				OR (EXCLUDED.usage_output_tokens = stored.usage_output_tokens AND EXCLUDED.sequence > stored.sequence))
		RETURNING organization_id AS "organizationId", device_id AS "deviceId", event_id AS "eventId",
			session_id AS "sessionId", sequence::text AS sequence, event_type AS "eventType",
			(xmax = 0) AS inserted,
			to_char(ingested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "ingestedAt"
	`);
	const changedEvents = z.array(changedEvent).parse(changed.rows);
	// These repairs also run on retries: a previous interrupted client can have
	// committed the events before receiving its acknowledgement.
	const turnIds = [
		...new Set(
			rows.flatMap((row) => {
				if (
					row.event_type !== "turn_context" &&
					row.event_type !== "token_usage_record"
				)
					return [];
				const parsed = turnReference.safeParse(row.payload);
				return parsed.success ? [parsed.data.turn_id] : [];
			}),
		),
	];
	if (turnIds.length > 0) {
		await transaction.execute(sql`
			UPDATE ${events} AS usage SET payload = usage.payload
			WHERE usage.organization_id = ${context.organizationId}::uuid AND usage.device_id = ${context.deviceId}::uuid
				AND usage.usage_at IS NOT NULL AND usage.model IS NULL
				AND usage.session_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(sessionIds)}::jsonb))
				AND usage.payload->>'turn_id' IN (SELECT jsonb_array_elements_text(${JSON.stringify(turnIds)}::jsonb))
		`);
	}
	const activityEvents = [
		...new Map(
			rows.flatMap((row) =>
				row.event_type === "tool_call" ||
				row.event_type === "tool_result" ||
				row.event_type === "token_usage_record" ||
				(row.event_type === "source_record" &&
					row.payload.sourceType === "cursor_hook:postToolUseFailure")
					? [
							[
								`${row.session_id}:${row.sequence}`,
								{ session_id: row.session_id, sequence: row.sequence },
							] as const,
						]
					: [],
			),
		).values(),
	];
	if (activityEvents.length > 0) {
		await transaction.execute(sql`
			UPDATE ${events} AS usage
			SET usage_activity = computed.activity, usage_after_error = computed.after_error
			FROM (
				SELECT target.event_id, activity.activity, activity.after_error
				FROM (
					SELECT DISTINCT following.event_id, following.session_id, following.sequence
					FROM jsonb_to_recordset(${JSON.stringify(activityEvents)}::jsonb) AS changed(session_id text, sequence bigint)
					CROSS JOIN LATERAL (
						SELECT candidate.event_id, candidate.session_id, candidate.sequence FROM ${events} AS candidate
						WHERE candidate.organization_id = ${context.organizationId}::uuid AND candidate.device_id = ${context.deviceId}::uuid
							AND candidate.session_id = changed.session_id AND candidate.usage_at IS NOT NULL
							AND candidate.sequence >= changed.sequence
						ORDER BY candidate.sequence LIMIT 3
					) AS following
				) AS target
				CROSS JOIN LATERAL ${activity}(${context.organizationId}::uuid, ${context.deviceId}::uuid, target.session_id, target.sequence) AS activity
			) AS computed
			WHERE usage.device_id = ${context.deviceId}::uuid AND usage.event_id = computed.event_id
				AND (usage.usage_activity IS DISTINCT FROM computed.activity OR usage.usage_after_error IS DISTINCT FROM computed.after_error)
		`);
	}
	const changes: TraceIngestChanges = {
		changedEvents,
		metadataSessionIds: [
			...new Set(
				changedEvents
					.filter((event) => event.eventType === "session_meta")
					.map((event) => event.sessionId),
			),
		],
		acceptedEventIds,
	};
	await extension?.(transaction, changes);
	return changes;
}
