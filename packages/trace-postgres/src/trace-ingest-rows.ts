import type { TraceEvent, TraceEventBatch } from "iteration-trace-contracts";
import * as z from "zod";
import {
	normalizeJsonbPayload,
	normalizeJsonbText,
} from "./normalize-jsonb-payload.js";

const usageReport = z.object({
	usage: z.object({ output_tokens: z.number().int().nonnegative() }),
});

function outputTokens(event: TraceEvent): number {
	const parsed = usageReport.safeParse(event.payload);
	return parsed.success ? parsed.data.usage.output_tokens : -1;
}

function preferred(current: TraceEvent, candidate: TraceEvent): TraceEvent {
	return candidate.eventType === "token_usage_record" &&
		current.eventType === "token_usage_record" &&
		outputTokens(candidate) >= outputTokens(current)
		? candidate
		: current;
}

export function prepareTraceIngestRows(batch: TraceEventBatch) {
	const acceptedEventIds: string[] = [];
	const unique = new Map<string, TraceEvent>();
	for (const event of batch.events) {
		acceptedEventIds.push(event.eventId);
		const current = unique.get(event.eventId);
		unique.set(
			event.eventId,
			current === undefined ? event : preferred(current, event),
		);
	}
	const events = [...unique.values()];
	const rows = events.map((event) => ({
		event_id: event.eventId,
		session_id: event.sessionId,
		sequence: event.sequence,
		call_id: event.callId === null ? null : normalizeJsonbText(event.callId),
		project_id: event.projectId,
		occurred_at: event.occurredAt,
		event_type: event.eventType,
		payload: normalizeJsonbPayload(event.payload),
		run: event.run ?? null,
	}));
	const sessionIds = [...new Set(rows.map((row) => row.session_id))].sort();
	return { events, rows, sessionIds, acceptedEventIds };
}
