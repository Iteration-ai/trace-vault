import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { installTraceProjections } from "iteration-trace-postgres/migrate";
import { Pool } from "pg";
import * as z from "zod";
import { storageSchema } from "./trace-storage.js";
import { upgradeVaultStorage } from "./upgrade-storage.js";

export async function migrateVault(
	databaseUrl: string,
	migrationsDirectory: string,
): Promise<void> {
	const parsed = z.url().safeParse(databaseUrl);
	if (!parsed.success || !/^postgres(?:ql)?:\/\//.test(parsed.data)) {
		throw new Error(
			"Vault migrations require an explicit PostgreSQL database URL",
		);
	}
	const url = new URL(parsed.data);
	if (!url.hostname || url.pathname.length < 2)
		throw new Error(
			"Configure the vault database host and database name explicitly",
		);
	const pool = new Pool({
		connectionString: databaseUrl,
		port: Number(url.port || 5432),
		max: 1,
	});
	try {
		const client = await pool.connect();
		try {
			const database = drizzle(client);
			// The dedicated connection retains the lock across the migrator's own transaction.
			await database.execute(sql`select pg_advisory_lock(186004595, 1)`);
			try {
				await migrate(database, {
					migrationsFolder: migrationsDirectory,
					migrationsSchema: "vault_migrations",
				});
				const { rows } = await client.query(
					"SELECT to_regclass('vault.storage_upgrade') IS NOT NULL AS canonical",
				);
				if (rows[0]?.canonical) {
					await installTraceProjections(client, storageSchema);
					await upgradeVaultStorage(client);
				}
			} finally {
				await database.execute(sql`select pg_advisory_unlock(186004595, 1)`);
			}
		} finally {
			client.release();
		}
	} catch (cause) {
		throw new Error("Vault database migration failed", { cause });
	} finally {
		await pool.end();
	}
}
