#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { VaultStore } from "./store.js";
import { createVaultServer } from "./http.js";
import { migrateVault } from "./migrate.js";

const configurationSchema = z.object({
	VAULT_DATABASE_URL: z.url(),
	VAULT_PUBLIC_URL: z.url(),
	VAULT_BOOTSTRAP_TOKEN: z.string().min(32).max(256),
	VAULT_PORT: z.coerce.number().int().min(1).max(65535).default(4310),
	VAULT_HOST: z.string().default("127.0.0.1"),
});

async function main(): Promise<void> {
	const parsed = configurationSchema.safeParse(process.env);
	if (!parsed.success)
		throw new Error(
			"Configure VAULT_DATABASE_URL, VAULT_PUBLIC_URL and a 32-character-or-longer VAULT_BOOTSTRAP_TOKEN.",
		);
	const config = parsed.data;
	const publicUrl = new URL(config.VAULT_PUBLIC_URL);
	if (
		publicUrl.username ||
		publicUrl.password ||
		publicUrl.search ||
		publicUrl.hash ||
		publicUrl.pathname !== "/" ||
		!(
			publicUrl.protocol === "https:" ||
			(publicUrl.protocol === "http:" &&
				["127.0.0.1", "localhost", "[::1]"].includes(publicUrl.hostname))
		)
	)
		throw new Error(
			"VAULT_PUBLIC_URL must be an HTTPS origin, or HTTP loopback for local development.",
		);
	const directory = path.dirname(fileURLToPath(import.meta.url));
	await migrateVault(
		config.VAULT_DATABASE_URL,
		path.join(directory, "migrations"),
	);
	const store = new VaultStore(config.VAULT_DATABASE_URL);
	const server = createVaultServer(store, {
		publicUrl: config.VAULT_PUBLIC_URL,
		bootstrapToken: config.VAULT_BOOTSTRAP_TOKEN,
		publicDirectory: path.join(directory, "public"),
	});
	let closing = false;
	const stop = () => {
		if (closing) return;
		closing = true;
		server.close(() => {
			store.close().catch(() => {
				process.exitCode = 1;
			});
		});
		const deadline = setTimeout(() => {
			server.closeAllConnections();
		}, 10_000);
		deadline.unref();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	server.on("error", (error) => {
		process.stderr.write(`Vault HTTP server failed: ${error.name}.\n`);
		stop();
		process.exitCode = 1;
	});
	server.listen(config.VAULT_PORT, config.VAULT_HOST, () => {
		process.stdout.write(
			`Trace vault listening on port ${config.VAULT_PORT}.\n`,
		);
	});
}

main().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Vault startup failed."}\n`,
	);
	process.exitCode = 1;
});
