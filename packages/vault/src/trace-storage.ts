import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import type { TraceEvent } from "iteration-trace-contracts";
import type { TraceStorageContext } from "iteration-trace-postgres";
import * as z from "zod";
import * as tables from "./schema.js";
import type { VaultSource } from "./store-contracts.js";

export type StorageTransaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
export const storageSchema = "vault_traces";

export async function storageContext(
	tx: StorageTransaction,
	memberId: string,
	source: VaultSource,
): Promise<TraceStorageContext> {
	await tx
		.insert(tables.sourceTenants)
		.values({ source })
		.onConflictDoNothing();
	const [tenant] = await tx
		.select()
		.from(tables.sourceTenants)
		.where(eq(tables.sourceTenants.source, source));
	if (!tenant) throw new Error("Trace source assignment is missing");
	await tx
		.insert(tables.storageStreams)
		.values({ organizationId: tenant.id, memberId, source })
		.onConflictDoNothing();
	const [stream] = await tx
		.select()
		.from(tables.storageStreams)
		.where(
			and(
				eq(tables.storageStreams.memberId, memberId),
				eq(tables.storageStreams.source, source),
			),
		);
	if (!stream) throw new Error("Trace storage assignment is missing");
	return {
		organizationId: stream.organizationId,
		userId: memberId,
		deviceId: stream.id,
		source,
	};
}

export function storageBatch(events: readonly TraceEvent[]) {
	return {
		events: events.map((event) => ({
			...event,
			projectId: z.uuid().safeParse(event.projectId).success
				? event.projectId
				: null,
		})),
	};
}

export async function saveTraceReceipts(
	tx: StorageTransaction,
	context: TraceStorageContext,
	deviceId: string,
	policyRevision: number,
	events: readonly TraceEvent[],
): Promise<void> {
	if (!events.length) return;
	await tx
		.insert(tables.eventReceipts)
		.values(
			events.map((event) => ({
				memberId: context.userId,
				source: context.source,
				eventId: event.eventId,
				storageStreamId: context.deviceId,
				projectId: event.projectId,
				occurredAt: event.occurredAt,
				deviceId,
				captureAuthorization: event.capture!,
				policyRevision,
			})),
		)
		.onConflictDoUpdate({
			target: [
				tables.eventReceipts.memberId,
				tables.eventReceipts.source,
				tables.eventReceipts.eventId,
			],
			set: {
				projectId: sql`excluded.project_id`,
				occurredAt: sql`excluded.occurred_at`,
				deviceId: sql`excluded.device_id`,
				captureAuthorization: sql`excluded.capture_authorization`,
				policyRevision: sql`excluded.policy_revision`,
			},
		});
	const sessions = new Map(
		events.map((event) => [
			event.sessionId,
			{
				memberId: context.userId,
				source: context.source,
				sourceSessionId: event.sessionId,
				storageStreamId: context.deviceId,
				projectId: event.projectId,
			},
		]),
	);
	await tx
		.insert(tables.sessionIdentifiers)
		.values([...sessions.values()])
		.onConflictDoUpdate({
			target: [
				tables.sessionIdentifiers.memberId,
				tables.sessionIdentifiers.source,
				tables.sessionIdentifiers.sourceSessionId,
			],
			set: {
				projectId: sql`coalesce(excluded.project_id, ${tables.sessionIdentifiers.projectId})`,
			},
		});
}

export const eventPayload = sql<TraceEvent>`jsonb_build_object(
	'eventId', ${tables.traceEvents.eventId},
	'sessionId', ${tables.traceEvents.sessionId},
	'sequence', ${tables.traceEvents.sequence},
	'callId', ${tables.traceEvents.callId},
	'projectId', ${tables.eventReceipts.projectId},
	'occurredAt', ${tables.eventReceipts.occurredAt},
	'eventType', ${tables.traceEvents.eventType},
	'payload', ${tables.traceEvents.payload},
	'capture', ${tables.eventReceipts.captureAuthorization}
) || case when ${tables.traceEvents.run} is null then '{}'::jsonb else jsonb_build_object('run', ${tables.traceEvents.run}) end`;

export const eventFields = {
	id: tables.eventReceipts.id,
	memberId: tables.eventReceipts.memberId,
	source: tables.eventReceipts.source,
	eventId: tables.eventReceipts.eventId,
	deviceId: tables.eventReceipts.deviceId,
	occurredAt: tables.eventReceipts.occurredAt,
	captureAuthorization: tables.eventReceipts.captureAuthorization,
	policyRevision: tables.eventReceipts.policyRevision,
	createdAt: tables.eventReceipts.createdAt,
	sourceSessionId: tables.traceEvents.sessionId,
	sequence: tables.traceEvents.sequence,
	payload: eventPayload,
};

export const receiptJoin = and(
	eq(tables.traceEvents.deviceId, tables.eventReceipts.storageStreamId),
	eq(tables.traceEvents.eventId, tables.eventReceipts.eventId),
);
export const sessionJoin = and(
	eq(tables.traceSessions.deviceId, tables.sessionIdentifiers.storageStreamId),
	eq(tables.traceSessions.userId, tables.sessionIdentifiers.memberId),
	eq(tables.traceSessions.sessionId, tables.sessionIdentifiers.sourceSessionId),
);
