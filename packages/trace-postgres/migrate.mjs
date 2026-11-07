import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const migrations = [
	"0001_trace_projections.sql",
	"0002_session_presentation.sql",
	"0003_payload_fields.sql",
];

function schemaNamespace(schema) {
	if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_")) {
		throw new Error("An explicit non-system PostgreSQL schema is required.");
	}
	return `"${schema}"`;
}

/** Installs canonical functions after the host has created its canonical tables and collector_devices relation. */
export async function installTraceProjections(client, schema) {
	const namespace = schemaNamespace(schema);
	const ledger = `${namespace}.__trace_engine_migrations`;
	await client.query("BEGIN");
	try {
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			[`trace-engine:${schema}`],
		);
		await client.query("SET LOCAL lock_timeout = '5s'");
		await client.query(`CREATE TABLE IF NOT EXISTS ${ledger} (
			version text PRIMARY KEY, checksum text NOT NULL, installed_at timestamptz NOT NULL DEFAULT now()
		)`);
		const { rows } = await client.query(
			`SELECT version, checksum FROM ${ledger} ORDER BY version`,
		);
		for (const row of rows) {
			if (!migrations.includes(row.version))
				throw new Error(
					`Trace engine schema ${schema} is newer than this engine.`,
				);
		}
		for (const version of migrations) {
			const template = await readFile(
				new URL(`./sql/${version}`, import.meta.url),
				"utf8",
			);
			const checksum = createHash("sha256").update(template).digest("hex");
			const installed = rows.find((row) => row.version === version);
			if (installed) {
				if (installed.checksum !== checksum)
					throw new Error(
						`Installed trace engine migration ${version} has changed.`,
					);
				continue;
			}
			await client.query(template.replaceAll("__TRACE_SCHEMA__", namespace));
			await client.query(
				`INSERT INTO ${ledger} (version, checksum) VALUES ($1, $2)`,
				[version, checksum],
			);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	}
}

const PAYLOAD_FIELDS_BACKFILL = "0003_payload_fields";

/**
 * Fills the SQL 0003 payload columns of rows written before it, in key order
 * and one committed batch at a time, so an interrupted run resumes. Rewriting
 * the payload fires the write trigger, which keeps the stored payload as is.
 */
export async function backfillTracePayloadFields(
	client,
	schema,
	batchSize = 2000,
) {
	const namespace = schemaNamespace(schema);
	const progress = `${namespace}.__trace_engine_backfills`;
	await client.query(`CREATE TABLE IF NOT EXISTS ${progress} (
		name text PRIMARY KEY, device_id uuid, event_id text, completed_at timestamptz
	)`);
	await client.query(
		`INSERT INTO ${progress} (name) VALUES ($1) ON CONFLICT DO NOTHING`,
		[PAYLOAD_FIELDS_BACKFILL],
	);
	for (;;) {
		await client.query("BEGIN");
		try {
			const { rows } = await client.query(
				`SELECT device_id, event_id, completed_at FROM ${progress} WHERE name = $1 FOR UPDATE`,
				[PAYLOAD_FIELDS_BACKFILL],
			);
			const position = rows[0];
			if (position.completed_at !== null) {
				await client.query("COMMIT");
				return;
			}
			// Each key is read through a lookup the planner cannot flatten into
			// a scan of the whole table.
			const { rows: moved } = await client.query(
				`WITH batch AS (
					SELECT device_id, event_id FROM ${namespace}.trace_events
					WHERE $1::uuid IS NULL OR (device_id, event_id) > ($1::uuid, $2::text)
					ORDER BY device_id, event_id LIMIT $3
				), rewritten AS (
					UPDATE ${namespace}.trace_events AS event SET payload = event.payload
					FROM batch CROSS JOIN LATERAL (
						SELECT stored.device_id, stored.event_id FROM ${namespace}.trace_events AS stored
						WHERE stored.device_id = batch.device_id AND stored.event_id = batch.event_id
						OFFSET 0
					) AS target
					WHERE event.device_id = target.device_id AND event.event_id = target.event_id
					RETURNING 1
				)
				SELECT last.device_id, last.event_id, (SELECT count(*) FROM rewritten) AS rewritten
				FROM (SELECT device_id, event_id FROM batch
					ORDER BY device_id DESC, event_id DESC LIMIT 1) AS last`,
				[position.device_id, position.event_id, batchSize],
			);
			const last = moved[0];
			await client.query(
				last === undefined
					? `UPDATE ${progress} SET completed_at = now() WHERE name = $1`
					: `UPDATE ${progress} SET device_id = $2, event_id = $3 WHERE name = $1`,
				last === undefined
					? [PAYLOAD_FIELDS_BACKFILL]
					: [PAYLOAD_FIELDS_BACKFILL, last.device_id, last.event_id],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		}
	}
}
