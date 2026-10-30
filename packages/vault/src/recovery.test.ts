import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { migrateVault } from "./migrate.js";
import { hashPassword, secretHash, verifyPassword } from "./password.js";
import { VaultStore } from "./store.js";
import { VaultStoreError } from "./store-contracts.js";

const databaseUrl = process.env.VAULT_TEST_DATABASE_URL;
const OLD_PASSWORD = "synthetic-old-admin-password";
const NEW_PASSWORD = "synthetic-new-admin-password";
const MEMBER_PASSWORD = "synthetic-member-password";
const session = () => ({
	tokenHash: secretHash(randomUUID()),
	expiresAt: new Date(Date.now() + 3_600_000),
});
const caller = (token: { tokenHash: string }) => ({
	kind: "session" as const,
	tokenHash: token.tokenHash,
});
const errorCode = (code: string) => (error: unknown) =>
	error instanceof VaultStoreError && error.code === code;

async function fixture(context: TestContext, initialized = true) {
	assert.ok(
		databaseUrl,
		"Use an explicit disposable local VAULT_TEST_DATABASE_URL",
	);
	const url = new URL(databaseUrl);
	assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
	const admin = new Pool({ connectionString: databaseUrl });
	const name = `vault_recovery_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE DATABASE "${name}"`);
	url.pathname = `/${name}`;
	const pool = new Pool({ connectionString: url.toString() });
	const store = new VaultStore(url.toString());
	context.after(async () => {
		await store.close();
		await pool.end();
		await admin.query(`DROP DATABASE "${name}"`);
		await admin.end();
	});
	await migrateVault(
		url.toString(),
		fileURLToPath(new URL("../migrations", import.meta.url)),
	);
	if (initialized)
		await store.initialize("Recovery fixture", {
			email: "admin@example.test",
			name: "Admin",
			passwordHash: await hashPassword(OLD_PASSWORD),
		});
	return { store, pool, url: url.toString() };
}

async function login(store: VaultStore, email: string, password: string) {
	const token = session();
	const member = await store.login(
		email,
		(hash) => verifyPassword(password, hash),
		token,
	);
	return { member, caller: caller(token) };
}

async function invite(
	store: VaultStore,
	admin: ReturnType<typeof caller>,
	email: string,
	role: "admin" | "member",
) {
	const invitation = session();
	const token = session();
	await store.createInvitation(admin, { email, name: email, role }, invitation);
	const member = await store.redeemInvitation(
		invitation.tokenHash,
		await hashPassword(MEMBER_PASSWORD),
		token,
	);
	return { member, caller: caller(token) };
}

async function snapshot(pool: Pool) {
	return Promise.all([
		pool.query("SELECT * FROM vault.members ORDER BY id"),
		pool.query("SELECT * FROM vault.auth_sessions ORDER BY id"),
		pool.query("SELECT * FROM vault.audit_entries ORDER BY id"),
	]).then((results) => results.map((result) => result.rows));
}

async function operator(
	args: string[],
	env: NodeJS.ProcessEnv,
	input = "",
	mode = 0o600,
) {
	const directory = await mkdtemp(path.join(tmpdir(), "vault-operator-"));
	const filename = path.join(directory, "password");
	await writeFile(filename, input, { mode });
	const file = await open(filename, "r");
	try {
		return await new Promise<{ code: number | null; output: string }>(
			(resolve, reject) => {
				const child = spawn(
					process.execPath,
					[
						"--import=tsx",
						fileURLToPath(new URL("./operator.ts", import.meta.url)),
						...args,
					],
					{
						env: { PATH: process.env.PATH, ...env },
						stdio: [file.fd, "pipe", "pipe"],
						timeout: 15_000,
					},
				);
				let output = "";
				assert.ok(child.stdout);
				assert.ok(child.stderr);
				child.stdout.on("data", (data: Buffer) => {
					output += data.toString();
				});
				child.stderr.on("data", (data: Buffer) => {
					output += data.toString();
				});
				child.once("error", reject);
				child.once("close", (code) => resolve({ code, output }));
			},
		);
	} finally {
		await file.close();
		await rm(directory, { recursive: true, force: true });
	}
}

test("operator help and errors require explicit vault authority and never echo argument secrets", async () => {
	const help = await operator(["--help"], {});
	assert.equal(help.code, 0);
	assert.match(help.output, /recover-admin --email/);
	assert.match(help.output, /disabled admins are rejected/);
	const missing = await operator(
		["recover-admin", "--email", "admin@example.test", "--password-stdin"],
		{ DATABASE_URL: "postgresql://ignored:secret@127.0.0.1/ignored" },
		NEW_PASSWORD,
	);
	assert.equal(missing.code, 1);
	assert.match(missing.output, /Set VAULT_DATABASE_URL explicitly/);
	assert.equal(missing.output.includes("ignored:secret"), false);
	const argument = await operator(
		[
			"recover-admin",
			"--email",
			"admin@example.test",
			"--password",
			NEW_PASSWORD,
		],
		{},
	);
	assert.equal(argument.code, 1);
	assert.equal(argument.output.includes(NEW_PASSWORD), false);
});

test("local CLI resets only the selected admin, invalidates all old sessions, and records a secret-free audit", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, pool, url } = await fixture(context);
	const admin = await login(store, "admin@example.test", OLD_PASSWORD);
	const second = await login(store, "admin@example.test", OLD_PASSWORD);
	const member = await invite(
		store,
		admin.caller,
		"member@example.test",
		"member",
	);
	const otherAdmin = await invite(
		store,
		admin.caller,
		"other-admin@example.test",
		"admin",
	);
	const device = session();
	await store.enrollDevice(admin.caller, {
		source: "claude",
		name: "Retained device",
		tokenHash: device.tokenHash,
	});
	const result = await operator(
		["recover-admin", "--email", " ADMIN@example.test ", "--password-stdin"],
		{
			VAULT_DATABASE_URL: url,
			DATABASE_URL: "postgresql://ignored:secret@invalid/ignored",
		},
		`${NEW_PASSWORD}\n`,
	);
	assert.equal(result.code, 0, result.output);
	assert.equal(result.output.includes(NEW_PASSWORD), false);
	assert.equal(result.output.includes(OLD_PASSWORD), false);
	await assert.rejects(
		login(store, "admin@example.test", OLD_PASSWORD),
		errorCode("unauthorized"),
	);
	await assert.rejects(store.me(admin.caller), errorCode("unauthorized"));
	await assert.rejects(store.me(second.caller), errorCode("unauthorized"));
	const recovered = await login(store, "admin@example.test", NEW_PASSWORD);
	assert.equal(recovered.member.id, admin.member.id);
	assert.deepEqual(recovered.member, admin.member);
	assert.equal((await store.me(member.caller)).id, member.member.id);
	assert.equal((await store.me(otherAdmin.caller)).id, otherAdmin.member.id);
	await login(store, "member@example.test", MEMBER_PASSWORD);
	await login(store, "other-admin@example.test", MEMBER_PASSWORD);
	assert.equal(
		(
			await store.deviceIdentity({
				kind: "device",
				tokenHash: device.tokenHash,
			})
		).id.length > 0,
		true,
	);
	const entries = (await store.listAudit(recovered.caller)).items.filter(
		(entry) => entry.action === "admin.password_recovered",
	);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.actorId, null);
	assert.equal(entries[0]?.targetId, admin.member.id);
	const audit = JSON.stringify(entries);
	assert.equal(audit.includes(NEW_PASSWORD), false);
	assert.equal(audit.includes(OLD_PASSWORD), false);
	assert.equal(audit.includes("scrypt$"), false);
	assert.equal(audit.includes(admin.caller.tokenHash), false);
	assert.equal(
		(
			await pool.query(
				"SELECT count(*)::int AS count FROM vault.auth_sessions WHERE member_id = $1 AND revoked = false",
				[admin.member.id],
			)
		).rows[0]?.count,
		1,
	);
	await assert.rejects(
		store.initialize("Never reopened", {
			email: "new@example.test",
			name: "New",
			passwordHash: "unused",
		}),
		errorCode("already_initialized"),
	);
});

test("recovery rejects members, unknown identities, disabled admins, and invalid input without changing any rows", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, pool, url } = await fixture(context);
	const admin = await login(store, "admin@example.test", OLD_PASSWORD);
	const member = await invite(
		store,
		admin.caller,
		"member@example.test",
		"member",
	);
	const disabled = await invite(
		store,
		admin.caller,
		"disabled@example.test",
		"admin",
	);
	await store.updateMember(admin.caller, disabled.member.id, {
		disabled: true,
	});
	for (const [email, password, code] of [
		["member@example.test", NEW_PASSWORD, "forbidden"],
		["unknown@example.test", NEW_PASSWORD, "not_found"],
		["disabled@example.test", NEW_PASSWORD, "forbidden"],
		["bad-address", NEW_PASSWORD, "invalid_input"],
		["admin@example.test", "too-short", "invalid_input"],
		["admin@example.test", "x".repeat(257), "invalid_input"],
	] as const) {
		const before = await snapshot(pool);
		await assert.rejects(
			store.recoverAdminPassword(email, password),
			errorCode(code),
		);
		assert.deepEqual(await snapshot(pool), before);
	}
	const before = await snapshot(pool);
	for (const [input, mode, extra] of [
		[`${NEW_PASSWORD}\n`, 0o644, ["--password-stdin"]],
		[`${NEW_PASSWORD}\nextra`, 0o600, ["--password-stdin"]],
		["x".repeat(2049), 0o600, ["--password-stdin"]],
		[NEW_PASSWORD, 0o600, []],
	] as const) {
		const result = await operator(
			["recover-admin", "--email", "admin@example.test", ...extra],
			{ VAULT_DATABASE_URL: url },
			input,
			mode,
		);
		assert.equal(result.code, 1);
		assert.equal(result.output.includes(NEW_PASSWORD), false);
		assert.deepEqual(await snapshot(pool), before);
	}
	assert.equal((await store.me(member.caller)).id, member.member.id);
	await login(store, "admin@example.test", OLD_PASSWORD);
});

test("recovery never bootstraps an empty vault and rolls back both password and sessions if audit fails", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, pool, url } = await fixture(context, false);
	await assert.rejects(
		store.recoverAdminPassword("admin@example.test", NEW_PASSWORD),
		errorCode("conflict"),
	);
	assert.equal((await store.status()).initialized, false);
	assert.deepEqual(await snapshot(pool), [[], [], []]);
	await store.initialize("Recovery fixture", {
		email: "admin@example.test",
		name: "Admin",
		passwordHash: await hashPassword(OLD_PASSWORD),
	});
	const admin = await login(store, "admin@example.test", OLD_PASSWORD);
	await pool.query(
		"ALTER TABLE vault.audit_entries ADD CONSTRAINT reject_recovery CHECK (action <> 'admin.password_recovered')",
	);
	const before = await snapshot(pool);
	await assert.rejects(
		store.recoverAdminPassword("admin@example.test", NEW_PASSWORD),
	);
	const result = await operator(
		["recover-admin", "--email", "admin@example.test", "--password-stdin"],
		{ VAULT_DATABASE_URL: url },
		NEW_PASSWORD,
	);
	assert.equal(result.code, 1);
	assert.equal(
		result.output,
		"Operator recovery failed; check the database and protected input.\n",
	);
	assert.deepEqual(await snapshot(pool), before);
	assert.equal((await store.me(admin.caller)).id, admin.member.id);
	await login(store, "admin@example.test", OLD_PASSWORD);
	await assert.rejects(
		login(store, "admin@example.test", NEW_PASSWORD),
		errorCode("unauthorized"),
	);
});

test("a concurrent old-password login cannot retain a usable session after recovery commits", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, pool, url } = await fixture(context);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const verifying = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const token = session();
	const pendingLogin = store.login(
		"admin@example.test",
		async (hash) => {
			entered();
			await gate;
			return verifyPassword(OLD_PASSWORD, hash);
		},
		token,
	);
	await verifying;
	const recovery = store.recoverAdminPassword(
		"admin@example.test",
		NEW_PASSWORD,
	);
	const completion = Promise.allSettled([pendingLogin, recovery]);
	try {
		const deadline = Date.now() + 3000;
		let waiting = false;
		do {
			const result = await pool.query<{ waiting: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock') AS waiting",
				[new URL(url).pathname.slice(1)],
			);
			waiting = result.rows[0]?.waiting ?? false;
			if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
		} while (!waiting && Date.now() < deadline);
		assert.equal(
			waiting,
			true,
			"Recovery must fence a still-verifying login before updating its password",
		);
	} finally {
		release();
		for (const result of await completion)
			assert.equal(result.status, "fulfilled");
	}
	await assert.rejects(store.me(caller(token)), errorCode("unauthorized"));
	await assert.rejects(
		login(store, "admin@example.test", OLD_PASSWORD),
		errorCode("unauthorized"),
	);
	await login(store, "admin@example.test", NEW_PASSWORD);
});
