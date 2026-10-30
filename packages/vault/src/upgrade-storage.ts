import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { parseTraceEventBatch } from "iteration-trace-contracts";
import { ingestTraceBatch } from "iteration-trace-postgres";
import type { PoolClient } from "pg";
import * as z from "zod";
import * as tables from "./schema.js";
import {
	eventPayload,
	receiptJoin,
	storageBatch,
	storageContext,
	storageSchema,
} from "./trace-storage.js";

const archivedEvent = z.object({
	id: z.uuid(),
	memberId: z.uuid(),
	source: z.enum(["claude", "codex", "cursor"]),
	eventId: z.string(),
	sessionId: z.string(),
	deviceId: z.uuid(),
	policyRevision: z.number().int(),
	receivedAt: z.iso.datetime(),
	payload: z.object({ projectId: z.string().nullable() }).passthrough(),
});

/** The server starts only after this stopped-writer, resumable archive upgrade completes. */
export async function upgradeVaultStorage(client: PoolClient): Promise<void> {
	const database = drizzle(client);
	const { rows: states } = await client.query(
		"SELECT last_event_id, completed_at FROM vault.storage_upgrade WHERE id = 1",
	);
	if (states[0]?.completed_at) return;
	await database.transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO vault.source_tenants (source) VALUES ('claude'), ('codex'), ('cursor') ON CONFLICT DO NOTHING`,
		);
		await tx.execute(sql`
			INSERT INTO vault.storage_streams (organization_id, member_id, source)
			SELECT tenant.id, assignment.member_id, assignment.source
			FROM (
				SELECT member_id, source FROM vault.devices
				UNION SELECT member_id, source FROM vault.legacy_trace_sessions
				UNION SELECT member_id, source FROM vault.legacy_session_tombstones
			) AS assignment JOIN vault.source_tenants AS tenant USING (source)
			ON CONFLICT DO NOTHING
		`);
		await tx.execute(sql`
			INSERT INTO vault.session_identifiers (id, member_id, source, source_session_id, storage_stream_id, project_id, title, created_at)
			SELECT session.id, session.member_id, session.source, session.source_session_id, stream.id, session.project_id, session.title, session.created_at
			FROM vault.legacy_trace_sessions AS session
			JOIN vault.storage_streams AS stream ON stream.member_id = session.member_id AND stream.source = session.source
			ON CONFLICT DO NOTHING
		`);
		await tx.execute(sql`
			INSERT INTO vault_traces.trace_session_deletions (organization_id, user_id, session_id, deleted_at)
			SELECT tenant.id, tombstone.member_id, tombstone.source_session_id, tombstone.created_at
			FROM vault.legacy_session_tombstones AS tombstone JOIN vault.source_tenants AS tenant USING (source)
			ON CONFLICT DO NOTHING
		`);
	});
	let lastEventId: string | null = states[0]?.last_event_id ?? null;
	for (;;) {
		const { rows } = await client.query(
			`
			SELECT id, member_id AS "memberId", source, event_id AS "eventId", source_session_id AS "sessionId",
				device_id AS "deviceId", policy_revision AS "policyRevision", payload,
				to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "receivedAt"
			FROM vault.legacy_trace_events WHERE ($1::uuid IS NULL OR id > $1::uuid)
			ORDER BY id LIMIT 50
		`,
			[lastEventId],
		);
		if (!rows.length) break;
		const archived = z.array(archivedEvent).parse(rows);
		await database.transaction(async (tx) => {
			const groups = new Map<string, typeof archived>();
			for (const row of archived) {
				const key = `${row.memberId}:${row.source}`;
				const group = groups.get(key) ?? [];
				group.push(row);
				groups.set(key, group);
			}
			for (const group of groups.values()) {
				const first = group[0]!;
				const context = await storageContext(tx, first.memberId, first.source);
				const events = group.map((row) => {
					const parsed = parseTraceEventBatch({
						events: [{ ...row.payload, projectId: null }],
					});
					const event = parsed.success ? parsed.value.events[0] : undefined;
					if (
						!event ||
						event.eventId !== row.eventId ||
						event.sessionId !== row.sessionId ||
						!event.capture
					) {
						throw new Error(
							"Archive identity or capture proof is inconsistent; restore the backup and repair the archive before upgrading",
						);
					}
					return { ...event, projectId: row.payload.projectId };
				});
				const changes = await ingestTraceBatch(
					tx,
					storageSchema,
					context,
					storageBatch(events),
					undefined,
					new Map(group.map((row) => [row.eventId, row.receivedAt])),
				);
				if (changes.changedEvents.length !== group.length)
					throw new Error(
						"Archived trace conflicts with a deletion or existing canonical event",
					);
				await tx.insert(tables.eventReceipts).values(
					group.map((row, index) => ({
						id: row.id,
						memberId: row.memberId,
						source: row.source,
						eventId: row.eventId,
						storageStreamId: context.deviceId,
						projectId: events[index]!.projectId,
						occurredAt: events[index]!.occurredAt,
						deviceId: row.deviceId,
						captureAuthorization: events[index]!.capture!,
						policyRevision: row.policyRevision,
						createdAt: sql`${row.receivedAt}::timestamptz`,
					})),
				);
			}
			await tx.execute(
				sql`UPDATE vault.storage_upgrade SET last_event_id = ${archived.at(-1)!.id}::uuid WHERE id = 1`,
			);
		});
		lastEventId = archived.at(-1)!.id;
	}
	await database.transaction(async (tx) => {
		const result = await tx.execute(sql`
			SELECT
				(SELECT count(*) FROM vault.legacy_trace_events) = (SELECT count(*) FROM vault.event_receipts) AS counts_match,
				NOT EXISTS (
					SELECT 1 FROM vault.legacy_trace_events AS original
					LEFT JOIN vault.event_receipts ON event_receipts.id = original.id
					LEFT JOIN vault_traces.trace_events ON ${receiptJoin}
					WHERE event_receipts.id IS NULL OR ${eventPayload} IS DISTINCT FROM original.payload
						OR event_receipts.device_id <> original.device_id OR event_receipts.created_at <> original.created_at
						OR event_receipts.capture_authorization IS DISTINCT FROM original.capture_authorization
						OR event_receipts.policy_revision <> original.policy_revision
				) AS payloads_match,
				NOT EXISTS (
					SELECT 1 FROM vault.legacy_trace_sessions AS original
					LEFT JOIN vault.session_identifiers AS identifier ON identifier.id = original.id
					LEFT JOIN vault_traces.trace_sessions AS session ON session.device_id = identifier.storage_stream_id AND session.session_id = identifier.source_session_id
					WHERE identifier.id IS NULL OR session.event_count IS DISTINCT FROM original.event_count::bigint
				) AS sessions_match
		`);
		const [verification] = z
			.array(
				z.object({
					counts_match: z.literal(true),
					payloads_match: z.literal(true),
					sessions_match: z.literal(true),
				}),
			)
			.parse(result.rows);
		if (!verification)
			throw new Error("Archive upgrade verification is missing");
		await tx.execute(sql`
			UPDATE vault_traces.trace_sessions AS session SET last_received_at = original.last_received_at
			FROM vault.legacy_trace_sessions AS original JOIN vault.session_identifiers AS identifier ON identifier.id = original.id
			WHERE session.device_id = identifier.storage_stream_id AND session.session_id = identifier.source_session_id
		`);
		await tx.execute(
			sql`DROP TABLE vault.legacy_trace_events, vault.legacy_trace_sessions, vault.legacy_session_tombstones`,
		);
		await tx.execute(
			sql`UPDATE vault.storage_upgrade SET completed_at = now() WHERE id = 1`,
		);
	});
}
