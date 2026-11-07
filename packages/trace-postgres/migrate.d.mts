export interface TraceMigrationClient {
	query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
/** Uses the supplied dedicated connection; must be called outside a transaction. */
export function installTraceProjections(
	client: TraceMigrationClient,
	schema: string,
): Promise<void>;
/** Resumable; uses the supplied dedicated connection outside a transaction. */
export function backfillTracePayloadFields(
	client: TraceMigrationClient,
	schema: string,
	batchSize?: number,
): Promise<void>;
