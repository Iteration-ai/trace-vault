import type { SQL } from "drizzle-orm";
import type {
	CollectorSource,
	TraceEventType,
} from "iteration-trace-contracts";

/** A host-authorized storage assignment, never an identity from an event body. */
export type TraceStorageContext = Readonly<{
	organizationId: string;
	userId: string;
	deviceId: string;
	source: CollectorSource;
}>;

/** The caller owns the transaction and must roll it back if an operation rejects. */
export interface TraceTransaction {
	execute(query: SQL): Promise<{ rows: unknown[] }>;
}

export type TraceChangedEvent = Readonly<{
	organizationId: string;
	deviceId: string;
	eventId: string;
	sessionId: string;
	sequence: number;
	eventType: TraceEventType;
	inserted: boolean;
	ingestedAt: string;
}>;

export type TraceIngestChanges = Readonly<{
	changedEvents: readonly TraceChangedEvent[];
	metadataSessionIds: readonly string[];
	acceptedEventIds: readonly string[];
}>;

export type TraceIngestExtension<TTransaction extends TraceTransaction> = (
	transaction: TTransaction,
	changes: TraceIngestChanges,
) => Promise<void>;

export type TraceDeleteResult = Readonly<{
	status: "not_found" | "deleted" | "already_deleted";
}>;
