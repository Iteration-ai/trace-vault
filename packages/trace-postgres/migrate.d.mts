export interface TraceMigrationClient {
	query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
/** Uses the supplied dedicated connection; must be called outside a transaction. */
export function installTraceProjections(
	client: TraceMigrationClient,
	schema: string,
): Promise<void>;
