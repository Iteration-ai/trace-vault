import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as z from "zod";

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
