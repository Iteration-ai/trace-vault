import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const migrations = [
	"0001_trace_projections.sql",
	"0002_session_presentation.sql",
];

/** Installs canonical functions after the host has created its canonical tables and collector_devices relation. */
export async function installTraceProjections(client, schema) {
	if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_")) {
		throw new Error("An explicit non-system PostgreSQL schema is required.");
	}
	const namespace = `"${schema}"`;
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
