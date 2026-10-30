#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
	OperatorInputError,
	readOperatorPassword,
} from "./operator-password.js";
import { VaultStore } from "./store.js";
import { VaultStoreError } from "./store-contracts.js";

const HELP = `Trace Vault local operator — database possession is authority.

Usage:
  VAULT_DATABASE_URL=<explicit PostgreSQL URL> node dist/operator.js recover-admin --email admin@example.com
  VAULT_DATABASE_URL=<explicit PostgreSQL URL> node dist/operator.js recover-admin --email admin@example.com --password-stdin < /private/new-password
  node dist/operator.js --help

Run inside the standalone vault package (or use the full path to dist/operator.js).
Only VAULT_DATABASE_URL is used; inherited DATABASE_URL is never consulted.
Recovery requires an already initialized database and an existing active admin.
Unknown users, members, and disabled admins are rejected without mutation.
Recovery never enables an account, changes a role, or reopens bootstrap.

Without --password-stdin, enter and confirm a hidden password in a private TTY.
Automation: stdin must be an operator-owned 0600 file or private pipe from a
trusted secret manager. Send one UTF-8 password, optionally followed by a newline.
Never put passwords in command arguments, environment variables, shell history,
or logs. Passwords must contain 12–256 characters. Input is bounded and times out.

The password change, revocation of ALL of that admin's sign-in sessions, and a
secret-free operator audit entry commit atomically. Other users, capture devices,
and traces are unchanged. Sign in normally with the new password afterwards.
No bootstrap token, public recovery endpoint, or running web server is needed.
This command does not migrate the database; use the deployed vault schema.
`;

async function main(): Promise<void> {
	let parsed;
	try {
		parsed = parseArgs({
			options: {
				email: { type: "string" },
				"password-stdin": { type: "boolean" },
				help: { type: "boolean" },
			},
			allowPositionals: true,
			strict: true,
		});
	} catch {
		throw new OperatorInputError(
			"Invalid arguments. Use --help; passwords are never accepted as arguments.",
		);
	}
	if (parsed.values.help) {
		process.stdout.write(HELP);
		return;
	}
	if (
		parsed.positionals.length !== 1 ||
		parsed.positionals[0] !== "recover-admin" ||
		!parsed.values.email
	)
		throw new OperatorInputError(
			"Use recover-admin --email <existing-admin-email>. See --help.",
		);
	const databaseUrl = process.env.VAULT_DATABASE_URL;
	if (!databaseUrl)
		throw new OperatorInputError(
			"Set VAULT_DATABASE_URL explicitly; DATABASE_URL is never used.",
		);
	const store = new VaultStore(databaseUrl);
	try {
		const password = await readOperatorPassword(
			parsed.values["password-stdin"] ?? false,
		);
		await store.recoverAdminPassword(parsed.values.email, password);
		process.stdout.write(
			"Administrator password recovered; prior sign-in sessions revoked.\n",
		);
	} finally {
		await store.close();
	}
}

main().catch((error: unknown) => {
	// Driver errors may embed connection URLs or SQL parameters; never print them.
	const message =
		error instanceof VaultStoreError || error instanceof OperatorInputError
			? error.message
			: "Operator recovery failed; check the database and protected input.";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
