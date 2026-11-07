import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type {
	JsonValue,
	TraceEventBatch,
	TraceEventType,
} from "iteration-trace-contracts";
import * as z from "zod";
import type { TraceStorageContext } from "./contracts.js";
import { prepareTraceIngestRows } from "./trace-ingest-rows.js";

/** Where one event's payload lives: a gzip member inside a host object. */
export type TracePayloadLocation = Readonly<{
	object: string;
	offset: number;
	length: number;
}>;

export type TracePayloadObject = Readonly<{ key: string; body: Uint8Array }>;

type TracePayload = Readonly<Record<string, JsonValue>>;

const payloadObjectSchema = z.record(z.string(), z.json());

const sha256 = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");

// Usage reports stay in PostgreSQL: they are small, and a later report for the
// same response replaces the stored one in place.
const storedExternally = (eventType: TraceEventType) =>
	eventType !== "token_usage_record";

/**
 * Packs a batch's payloads into one object per session, one gzip member per
 * event, readable by byte range or whole. Keys depend only on the stream,
 * session and payloads, so a retried upload rewrites the same object. Hosts
 * store the objects, then pass the locations to ingestTraceBatch.
 */
export function packTracePayloads(
	context: TraceStorageContext,
	batch: TraceEventBatch,
): Readonly<{
	objects: readonly TracePayloadObject[];
	locations: ReadonlyMap<string, TracePayloadLocation>;
}> {
	const { rows } = prepareTraceIngestRows(batch);
	const bySession = new Map<string, typeof rows>();
	for (const row of rows) {
		if (!storedExternally(row.event_type)) continue;
		const session = bySession.get(row.session_id) ?? [];
		session.push(row);
		bySession.set(row.session_id, session);
	}
	const objects: TracePayloadObject[] = [];
	const locations = new Map<string, TracePayloadLocation>();
	for (const [sessionId, sessionRows] of bySession) {
		sessionRows.sort(
			(a, b) =>
				a.sequence - b.sequence ||
				(a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0),
		);
		const members = sessionRows.map((row) =>
			gzipSync(`${JSON.stringify(row.payload)}\n`),
		);
		const key = [
			context.organizationId,
			context.deviceId,
			sha256(sessionId),
			`${sha256(
				sessionRows
					.map((row, index) => `${row.event_id}\0${sha256(members[index]!)}`)
					.join("\n"),
			)}.jsonl.gz`,
		].join("/");
		let offset = 0;
		sessionRows.forEach((row, index) => {
			const length = members[index]!.byteLength;
			locations.set(row.event_id, { object: key, offset, length });
			offset += length;
		});
		objects.push({ key, body: Buffer.concat(members) });
	}
	return { objects, locations };
}

/** Reads the payload from the bytes at its location: one gzip member. */
export function readTracePayload(member: Uint8Array): TracePayload {
	return payloadObjectSchema.parse(
		JSON.parse(gunzipSync(member).toString("utf8")),
	);
}

/** Reads every payload in a stored object, in the order they were packed. */
export function readTracePayloadObject(body: Uint8Array): TracePayload[] {
	return gunzipSync(body)
		.toString("utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => payloadObjectSchema.parse(JSON.parse(line)));
}
