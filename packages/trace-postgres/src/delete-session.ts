import { sql } from "drizzle-orm";
import * as z from "zod";
import type {
	TraceDeleteResult,
	TraceStorageContext,
	TraceTransaction,
} from "./contracts.js";
import { assertTraceSchema } from "./schema.js";

/** Checks the selected stream exists, then deletes the contributor's session across streams. */
export async function deleteTraceSession<TTransaction extends TraceTransaction>(
	transaction: TTransaction,
	schema: string,
	context: TraceStorageContext,
	sessionId: string,
	beforeDelete?: (transaction: TTransaction) => Promise<void>,
	options: Readonly<{ tombstoneMissing?: boolean }> = {},
): Promise<TraceDeleteResult> {
	assertTraceSchema(schema);
	const events = sql`${sql.identifier(schema)}.${sql.identifier("trace_events")}`;
	const sessions = sql`${sql.identifier(schema)}.${sql.identifier("trace_sessions")}`;
	const deletions = sql`${sql.identifier(schema)}.${sql.identifier("trace_session_deletions")}`;
	await transaction.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.organizationId}:${context.userId}:${sessionId}`}, 0))`,
	);
	const scope = sql`organization_id = ${context.organizationId}::uuid AND user_id = ${context.userId}::uuid AND session_id = ${sessionId}`;
	const result = await transaction.execute(sql`
		SELECT EXISTS (SELECT 1 FROM ${sessions} WHERE ${scope} AND device_id = ${context.deviceId}::uuid) AS present,
			EXISTS (SELECT 1 FROM ${deletions} WHERE ${scope}) AS deleted
	`);
	const [state] = z
		.array(z.object({ present: z.boolean(), deleted: z.boolean() }))
		.parse(result.rows);
	if (!state) throw new Error("Session deletion state is missing.");
	if (!state.present && !state.deleted && !options.tombstoneMissing)
		return { status: "not_found" };
	await transaction.execute(sql`
		INSERT INTO ${deletions} (organization_id, user_id, session_id)
		VALUES (${context.organizationId}::uuid, ${context.userId}::uuid, ${sessionId})
		ON CONFLICT (organization_id, user_id, session_id) DO NOTHING
	`);
	// Native hosts can retain event-ID tombstones and audit metadata before
	// cascading foreign keys remove their receipts with the canonical events.
	await beforeDelete?.(transaction);
	await transaction.execute(sql`DELETE FROM ${events} WHERE ${scope}`);
	await transaction.execute(sql`DELETE FROM ${sessions} WHERE ${scope}`);
	return { status: state.deleted ? "already_deleted" : "deleted" };
}
