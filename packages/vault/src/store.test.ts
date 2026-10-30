import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TraceEvent } from "iteration-trace-contracts";
import { Pool } from "pg";
import { migrateVault } from "./migrate.js";
import { VaultStore } from "./store.js";
import { type VaultCaller, VaultStoreError } from "./store-contracts.js";

const databaseUrl = process.env.VAULT_TEST_DATABASE_URL;
const tokenHash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const token = (value: string) => ({
	tokenHash: tokenHash(value),
	expiresAt: new Date(Date.now() + 3600000),
});
const caller = (
	value: string,
	kind: "session" | "device" = "session",
): VaultCaller => ({ kind, tokenHash: tokenHash(value) });
const errorCode = (code: string) => (error: unknown) =>
	error instanceof VaultStoreError && error.code === code;
const migrationsDirectory = fileURLToPath(
	new URL("../migrations", import.meta.url),
);

async function fixture(
	context: TestContext,
	raceBootstrap = false,
	migrations = migrationsDirectory,
) {
	assert.ok(
		databaseUrl,
		"Set VAULT_TEST_DATABASE_URL to an explicit disposable local PostgreSQL URL",
	);
	const url = new URL(databaseUrl);
	assert.ok(
		["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
		"Vault tests require local disposable Postgres",
	);
	const admin = new Pool({ connectionString: databaseUrl });
	const database = `vault_test_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE DATABASE "${database}"`);
	url.pathname = `/${database}`;
	const pool = new Pool({ connectionString: url.toString() });
	const store = new VaultStore(url.toString());
	context.after(async () => {
		await store.close();
		await pool.end();
		await admin.query(`DROP DATABASE "${database}"`);
		await admin.end();
	});
	await Promise.all(
		Array.from({ length: raceBootstrap ? 2 : 1 }, () =>
			migrateVault(url.toString(), migrations),
		),
	);
	await store.ready();
	assert.deepEqual(await store.status(), {
		initialized: false,
		name: null,
		id: null,
	});
	const initialIdentity = {
		email: " ADMIN@example.test ",
		name: "Administrator",
		passwordHash: "synthetic-admin-password-hash",
	};
	const attempts = await Promise.allSettled(
		Array.from({ length: raceBootstrap ? 2 : 1 }, () =>
			store.initialize("Synthetic Company", initialIdentity),
		),
	);
	assert.equal(
		attempts.filter((result) => result.status === "fulfilled").length,
		1,
	);
	if (raceBootstrap)
		assert.equal(
			attempts.filter(
				(result) =>
					result.status === "rejected" &&
					errorCode("already_initialized")(result.reason),
			).length,
			1,
		);
	const winner = attempts.find((result) => result.status === "fulfilled");
	assert.ok(winner?.status === "fulfilled");
	const initial = winner.value;
	const status = await store.status();
	assert.equal(status.initialized, true);
	assert.equal(status.name, "Synthetic Company");
	assert.match(status.id ?? "", /^[a-f0-9-]{36}$/);
	await store.login(
		"admin@example.test",
		async (hash) => hash === "synthetic-admin-password-hash",
		token("admin"),
	);
	const adminCaller = caller("admin");
	const invite = await store.createInvitation(
		adminCaller,
		{ email: "member@example.test", name: "Member", role: "member" },
		token("invite"),
	);
	const member = await store.redeemInvitation(
		tokenHash("invite"),
		"synthetic-member-password-hash",
		token("member"),
	);
	const memberCaller = caller("member");
	const policy = await store.updateRepositories(adminCaller, [
		"github.com/synthetic/company",
	]);
	const device = await store.enrollDevice(memberCaller, {
		source: "claude",
		name: "Synthetic machine",
		tokenHash: tokenHash("device"),
	});
	return {
		store,
		pool,
		databaseUrl: url.toString(),
		initial,
		member,
		invite,
		policy,
		device,
		adminCaller,
		memberCaller,
		deviceCaller: caller("device", "device"),
	};
}

function event(
	eventId: string,
	revision: number,
	sessionId = "source-session",
): TraceEvent {
	return {
		eventId,
		sessionId,
		sequence: 0,
		callId: null,
		projectId: "project-1",
		occurredAt: "2026-01-01T00:00:00.000Z",
		eventType: "session_meta",
		payload: {
			cwd: "/synthetic/repository",
			title: "Source title",
			git: { repository_url: "git@github.com:synthetic/company.git" },
			full: ["original", { nested: true }],
		},
		capture: {
			revision,
			basis: "repository",
			reference: "github.com/synthetic/company",
		},
	};
}

test("vault bootstrap, password authentication, single-use invitation, and last-admin gate", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, initial, member, adminCaller, memberCaller, invite, pool } =
		await fixture(context);
	assert.equal(initial.email, "admin@example.test");
	assert.equal(initial.role, "admin");
	assert.equal(member.role, "member");
	await assert.rejects(
		store.initialize("Other", {
			email: "other@example.test",
			name: "Other",
			passwordHash: "other",
		}),
		errorCode("already_initialized"),
	);
	await assert.rejects(
		store.login("admin@example.test", async () => false, token("bad-login")),
		errorCode("unauthorized"),
	);
	let dummyVerified = false;
	await assert.rejects(
		store.login(
			"nonexistent@example.test",
			async () => {
				dummyVerified = true;
				return true;
			},
			token("nonexistent"),
		),
		errorCode("unauthorized"),
	);
	assert.equal(dummyVerified, true);
	await assert.rejects(
		store.redeemInvitation(
			tokenHash("invite"),
			"another-hash",
			token("second-redemption"),
		),
		errorCode("unauthorized"),
	);
	await assert.rejects(
		store.createInvitation(
			adminCaller,
			{ email: "MEMBER@example.test", name: "Duplicate", role: "member" },
			token("duplicate"),
		),
		errorCode("conflict"),
	);
	await assert.rejects(
		store.updateMember(adminCaller, initial.id, {
			role: "admin",
			disabled: true,
		}),
		errorCode("conflict"),
	);
	await assert.rejects(
		store.updateMember(adminCaller, initial.id, {
			role: "member",
			disabled: false,
		}),
		errorCode("conflict"),
	);
	const spoofedCaller = { ...memberCaller, role: "admin" };
	await assert.rejects(
		store.listMembers(spoofedCaller),
		errorCode("forbidden"),
	);
	assert.equal((await store.me(memberCaller)).id, member.id);
	assert.equal(
		(await store.listInvitations(adminCaller)).items.find(
			(row) => row.id === invite.id,
		)?.redeemedAt instanceof Date,
		true,
	);
	assert.equal("passwordHash" in (await store.me(adminCaller)), false);
	await pool.query(
		"UPDATE vault.auth_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
		[tokenHash("member")],
	);
	await assert.rejects(store.me(memberCaller), errorCode("unauthorized"));
	await store.logout(adminCaller);
	await assert.rejects(store.me(adminCaller), errorCode("unauthorized"));
});

test("vault ingestion preserves full payload, deduplicates across enrollments, and bounds owner/admin exports", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, member, adminCaller, memberCaller, deviceCaller, policy } =
		await fixture(context);
	const original = event("event-1", policy.revision);
	assert.deepEqual(
		await store.ingest(deviceCaller, policy.revision, [original, original]),
		{ acceptedEventIds: ["event-1"], insertedCount: 1 },
	);
	await store.enrollDevice(memberCaller, {
		source: "claude",
		name: "Second machine",
		tokenHash: tokenHash("device-2"),
	});
	assert.equal(
		(
			await store.ingest(caller("device-2", "device"), policy.revision, [
				original,
			])
		).insertedCount,
		0,
	);
	assert.equal(
		(
			await store.ingest(deviceCaller, policy.revision, [
				event("event-2", policy.revision, "other-session"),
			])
		).insertedCount,
		1,
	);
	const identity = {
		memberId: member.id,
		source: "claude" as const,
		sourceSessionId: "source-session",
	};
	const detail = await store.getSession(memberCaller, identity);
	assert.equal(detail.cwd, "/synthetic/repository");
	assert.equal(detail.title, "Source title");
	assert.equal(detail.projectId, "project-1");
	assert.equal(detail.repository, "github.com/synthetic/company");
	assert.equal(detail.eventCount, 1);
	assert.equal(detail.contributorName, "Member");
	assert.equal(detail.contributorId, member.id);
	assert.deepEqual(await store.getSessionById(memberCaller, detail.id), detail);
	await store.ingest(deviceCaller, policy.revision, [original]);
	const retried = await store.getSessionById(memberCaller, detail.id);
	assert.equal(retried.eventCount, 1);
	assert.deepEqual(retried.lastReceivedAt, detail.lastReceivedAt);
	const saved = (await store.readEvents(memberCaller, identity)).items;
	assert.equal(saved.length, 1);
	assert.deepEqual(saved[0]?.payload, original);
	assert.deepEqual(saved[0]?.captureAuthorization, original.capture);
	assert.equal(saved[0]?.memberId, member.id);
	const page = await store.listSessions(memberCaller, { limit: 1 });
	assert.equal(page.items.length, 1);
	assert.ok(page.nextCursor);
	const second = await store.listSessions(memberCaller, {
		after: page.nextCursor,
		limit: 1,
	});
	assert.equal(second.items.length, 1);
	assert.notEqual(page.items[0]?.id, second.items[0]?.id);
	assert.equal(second.nextCursor, null);
	const exportPage = await store.readEvents(adminCaller, null, { limit: 1 });
	assert.equal(exportPage.items.length, 1);
	assert.ok(exportPage.nextCursor);
	assert.equal(
		(
			await store.readEvents(adminCaller, null, {
				limit: 1,
				after: exportPage.nextCursor,
			})
		).items.length,
		1,
	);
	await assert.rejects(
		store.listSessions(memberCaller, { limit: 201 }),
		errorCode("invalid_input"),
	);
	await assert.rejects(
		store.readEvents(deviceCaller, null),
		errorCode("forbidden"),
	);
});

test("session titles fall back to the first nonempty user message, never assistant text or internal IDs", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, policy, member, memberCaller, deviceCaller } =
		await fixture(context);
	for (const source of ["claude", "cursor", "codex"] as const) {
		if (source !== "claude")
			await store.enrollDevice(memberCaller, {
				source,
				name: source,
				tokenHash: tokenHash(source),
			});
		const device =
			source === "claude" ? deviceCaller : caller(source, "device");
		const identity = {
			memberId: member.id,
			source,
			sourceSessionId: "shared-source-id",
		};
		const message = (
			id: string,
			sequence: number,
			payload: TraceEvent["payload"],
		): TraceEvent => ({
			...event(id, policy.revision, identity.sourceSessionId),
			eventType: "user_message",
			sequence,
			payload,
		});
		const first = message(
			"z-first",
			10,
			source === "codex"
				? {
						content: [
							{ type: "input_image", image_url: "not title text" },
							{ type: "input_text", text: ` Investigate\n ${source}` },
							{ type: "input_text", text: "retries " },
						],
					}
				: { text: ` Investigate\n ${source} retries ` },
		);
		const original = [
			message("later", 30, { message: "Later request" }),
			{
				...message("assistant", 0, { text: "Do not use assistant text" }),
				eventType: "assistant_message" as const,
			},
			message("blank", 1, { text: " \n\t\u00a0\ufeff " }),
			first,
		];
		await store.ingest(device, policy.revision, original);
		const detail = await store.getSession(memberCaller, identity);
		assert.equal(detail.title, `Investigate ${source} retries`);
		assert.equal(
			(await store.getSessionById(memberCaller, detail.id)).title,
			detail.title,
		);
		assert.equal(
			(await store.listSessions(memberCaller)).items.find(
				(row) => row.id === detail.id,
			)?.title,
			detail.title,
		);
		assert.deepEqual(
			(await store.readEvents(memberCaller, identity)).items.find(
				(row) => row.eventId === "z-first",
			)?.payload,
			first,
		);
		await store.ingest(device, policy.revision, [
			message("a-first", 10, { message: `Earlier ${source} tie` }),
		]);
		assert.equal(
			(await store.getSession(memberCaller, identity)).title,
			`Earlier ${source} tie`,
		);
		await store.ingest(device, policy.revision, [
			message("earliest", 5, { text: `First ${source} prompt` }),
		]);
		assert.equal(
			(await store.getSession(memberCaller, identity)).title,
			`First ${source} prompt`,
		);
		await store.ingest(device, policy.revision, original);
		assert.equal(
			(await store.getSession(memberCaller, identity)).title,
			`First ${source} prompt`,
		);
		await store.ingest(device, policy.revision, [
			message("\uE000", 4, { text: `Stable ${source} tie` }),
			message("😀", 4, { text: "Not the first ID in database order" }),
		]);
		assert.equal(
			(await store.getSession(memberCaller, identity)).title,
			`Stable ${source} tie`,
		);
		await store.ingest(device, policy.revision, [
			{
				...event("real-title", policy.revision, identity.sourceSessionId),
				payload: { title: ` Native ${source} title ` },
			},
		]);
		await store.ingest(device, policy.revision, [
			message("even-earlier", 2, { text: "Must not replace native title" }),
			{
				...event("blank-title", policy.revision, identity.sourceSessionId),
				payload: { title: " \n " },
			},
		]);
		assert.equal(
			(await store.getSession(memberCaller, identity)).title,
			`Native ${source} title`,
		);
	}
	await store.ingest(deviceCaller, policy.revision, [
		{
			...event("no-text", policy.revision, "no-text"),
			eventType: "user_message",
			payload: { content: [{ type: "input_image" }] },
		},
	]);
	assert.equal(
		(
			await store.getSession(memberCaller, {
				memberId: member.id,
				source: "claude",
				sourceSessionId: "no-text",
			})
		).title,
		null,
	);
	await store.ingest(deviceCaller, policy.revision, [
		{
			...event("long-message", policy.revision, "long-message"),
			eventType: "user_message",
			payload: { text: "😀".repeat(161) },
		},
	]);
	assert.equal(
		(
			await store.getSession(memberCaller, {
				memberId: member.id,
				source: "claude",
				sourceSessionId: "long-message",
			})
		).title,
		"😀".repeat(160),
	);
});

test("existing archives retain titles, public identities and exports through an interrupted, resumed storage upgrade", {
	skip: !databaseUrl,
}, async (context) => {
	const historicalMigrations = await mkdtemp(
		path.join(tmpdir(), "vault-title-migration-"),
	);
	context.after(() =>
		rm(historicalMigrations, { recursive: true, force: true }),
	);
	await cp(migrationsDirectory, historicalMigrations, { recursive: true });
	const journalFile = path.join(historicalMigrations, "meta", "_journal.json");
	const journal = JSON.parse(await readFile(journalFile, "utf8"));
	journal.entries = journal.entries.filter(
		(entry: { idx: number }) => entry.idx < 2,
	);
	await writeFile(journalFile, JSON.stringify(journal));
	const {
		store,
		pool,
		member,
		device,
		policy,
		memberCaller,
		deviceCaller,
		databaseUrl: url,
	} = await fixture(context, false, historicalMigrations);
	const cases: {
		id: string;
		title: string | null;
		payload: TraceEvent["payload"];
		expected: string | null;
	}[] = [
		{
			id: "plain",
			title: null,
			payload: { text: " \n Investigate\t webhook retries " },
			expected: "Investigate webhook retries",
		},
		{
			id: "message",
			title: "  ",
			payload: { text: "\n\u00a0\ufeff", message: "Message\u202f fallback" },
			expected: "Message fallback",
		},
		{
			id: "blocks",
			title: null,
			payload: {
				content: [
					{ type: "input_text", text: "Review" },
					{ type: "input_image", text: "Ignore" },
					{ type: "text", text: " the migration" },
				],
			},
			expected: "Review the migration",
		},
		{
			id: "native",
			title: "Original title",
			payload: { text: "Not the title" },
			expected: "Original title",
		},
		{
			id: "empty",
			title: null,
			payload: { content: [{ type: "input_image" }] },
			expected: null,
		},
		{
			id: "long",
			title: null,
			payload: { text: "😀".repeat(161) },
			expected: "😀".repeat(160),
		},
	];
	for (const row of cases) {
		await pool.query(
			"INSERT INTO vault.trace_sessions (member_id, source, source_session_id, title, event_count) VALUES ($1, 'claude', $2, $3, 3)",
			[member.id, row.id, row.title],
		);
		for (const [id, sequence, payload] of [
			["later", 20, { text: "Later arrival" }],
			["😀", 5, { text: "Loses same-sequence tie" }],
			["\uE000", 5, row.payload],
		] as const) {
			const original: TraceEvent = {
				...event(`${row.id}-${id}`, policy.revision, row.id),
				eventType: row.id === "empty" ? "assistant_message" : "user_message",
				sequence,
				payload,
			};
			await pool.query(
				"INSERT INTO vault.trace_events (member_id, source, source_session_id, event_id, sequence, device_id, payload, capture_authorization, policy_revision) VALUES ($1, 'claude', $2, $3, $4, $5, $6, $7, $8)",
				[
					member.id,
					row.id,
					original.eventId,
					sequence,
					device.id,
					original,
					original.capture,
					policy.revision,
				],
			);
		}
	}
	await pool.query(
		"INSERT INTO vault.trace_sessions (member_id, source, source_session_id, title, event_count) VALUES ($1, 'claude', 'upgrade-batches', 'Batch archive', 55)",
		[member.id],
	);
	for (let index = 1; index <= 55; index++) {
		const original: TraceEvent = {
			...event(
				index === 55 ? "upgrade-stop" : `upgrade-${index}`,
				policy.revision,
				"upgrade-batches",
			),
			eventType: "source_record",
			sequence: index,
			payload: { sourceType: "synthetic", text: `Retained ${index}` },
		};
		await pool.query(
			"INSERT INTO vault.trace_events (id, member_id, source, source_session_id, event_id, sequence, device_id, payload, capture_authorization, policy_revision, created_at) VALUES ($1, $2, 'claude', $3, $4, $5, $6, $7, $8, $9, '2025-01-02T03:04:05.123456Z')",
			[
				index === 55
					? "ffffffff-ffff-4fff-bfff-ffffffffffff"
					: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				member.id,
				original.sessionId,
				original.eventId,
				index,
				device.id,
				original,
				original.capture,
				policy.revision,
			],
		);
	}
	const before = (
		await pool.query(
			"SELECT id, payload, device_id, created_at FROM vault.trace_events ORDER BY event_id",
		)
	).rows;
	const sessionIds = (
		await pool.query("SELECT id, source_session_id FROM vault.trace_sessions")
	).rows;
	await pool.query(
		"INSERT INTO vault.session_tombstones (member_id, source, source_session_id) VALUES ($1, 'claude', 'deleted-before-upgrade')",
		[member.id],
	);
	await pool.query(
		"INSERT INTO vault.event_tombstones (member_id, source, event_id) VALUES ($1, 'claude', 'event-deleted-before-upgrade')",
		[member.id],
	);
	const interrupted = await mkdtemp(
		path.join(tmpdir(), "vault-storage-interruption-"),
	);
	context.after(() => rm(interrupted, { recursive: true, force: true }));
	await cp(migrationsDirectory, interrupted, { recursive: true });
	const upgradeFile = path.join(interrupted, "0003_canonical_trace_engine.sql");
	await writeFile(
		upgradeFile,
		`${await readFile(upgradeFile, "utf8")}
--> statement-breakpoint
CREATE FUNCTION vault.interrupt_upgrade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id = 'upgrade-stop' THEN RAISE EXCEPTION 'synthetic interruption'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER interrupt_upgrade BEFORE INSERT ON vault.event_receipts FOR EACH ROW EXECUTE FUNCTION vault.interrupt_upgrade();
`,
	);
	await assert.rejects(
		migrateVault(url, interrupted),
		/Vault database migration failed/,
	);
	assert.equal(
		(
			await pool.query(
				"SELECT count(*)::int AS count FROM vault.event_receipts",
			)
		).rows[0].count,
		50,
	);
	assert.equal(
		(
			await pool.query(
				"SELECT count(*)::int AS count FROM vault.legacy_trace_events",
			)
		).rows[0].count,
		before.length,
	);
	await pool.query(
		"DROP TRIGGER interrupt_upgrade ON vault.event_receipts; DROP FUNCTION vault.interrupt_upgrade()",
	);
	await migrateVault(url, migrationsDirectory);
	await migrateVault(url, migrationsDirectory);
	for (const row of cases) {
		assert.equal(
			(
				await store.getSession(memberCaller, {
					memberId: member.id,
					source: "claude",
					sourceSessionId: row.id,
				})
			).title,
			row.expected,
		);
	}
	for (const session of sessionIds) {
		assert.equal(
			(await store.getSessionById(memberCaller, session.id)).sourceSessionId,
			session.source_session_id,
		);
	}
	const after = (await store.readEvents(memberCaller, null, { limit: 200 }))
		.items;
	assert.deepEqual(
		new Map(
			after.map((row) => [
				row.id,
				{
					payload: row.payload,
					deviceId: row.deviceId,
					createdAt: row.createdAt,
				},
			]),
		),
		new Map(
			before.map((row) => [
				row.id,
				{
					payload: row.payload,
					deviceId: row.device_id,
					createdAt: row.created_at,
				},
			]),
		),
	);
	assert.equal(
		(
			await store.ingest(deviceCaller, policy.revision, [
				event(
					"new-id-in-deleted-session",
					policy.revision,
					"deleted-before-upgrade",
				),
				event(
					"event-deleted-before-upgrade",
					policy.revision,
					"renamed-after-upgrade",
				),
			])
		).insertedCount,
		0,
	);
});

test("vault uses canonical streaming usage replacement without duplicating sessions or replacing ordinary retries", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, member, memberCaller, deviceCaller, policy } =
		await fixture(context);
	const usage = (output: number, sequence: number): TraceEvent => ({
		...event("streaming-usage", policy.revision),
		eventType: "token_usage_record",
		sequence,
		payload: {
			model: "synthetic",
			usage: { input_tokens: 23, output_tokens: output },
		},
	});
	const best = usage(13, 7);
	assert.equal(
		(
			await store.ingest(deviceCaller, policy.revision, [
				usage(5, 3),
				best,
				usage(8, 8),
			])
		).insertedCount,
		1,
	);
	const identity = {
		memberId: member.id,
		source: "claude" as const,
		sourceSessionId: "source-session",
	};
	assert.deepEqual(
		(await store.readEvents(memberCaller, identity)).items[0]?.payload,
		best,
	);
	const later = usage(13, 9);
	assert.equal(
		(await store.ingest(deviceCaller, policy.revision, [later])).insertedCount,
		0,
	);
	await store.ingest(deviceCaller, policy.revision, [usage(6, 20)]);
	await store.ingest(deviceCaller, policy.revision, [usage(13, 8)]);
	assert.deepEqual(
		(await store.readEvents(memberCaller, identity)).items[0]?.payload,
		later,
	);
	const original = event("ordinary-retry", policy.revision);
	await store.ingest(deviceCaller, policy.revision, [
		original,
		{ ...original, payload: { title: "Must not replace first capture" } },
	]);
	assert.deepEqual(
		(await store.readEvents(memberCaller, identity)).items.find(
			(row) => row.eventId === original.eventId,
		)?.payload,
		original,
	);
	assert.equal((await store.getSession(memberCaller, identity)).eventCount, 2);
});

test("vault policy changes fence ingestion and proofs require approved references", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, adminCaller, memberCaller, deviceCaller, policy } =
		await fixture(context);
	const { capture: _capture, ...noProof } = event("missing", policy.revision);
	await assert.rejects(
		store.ingest(deviceCaller, policy.revision, [noProof]),
		errorCode("forbidden"),
	);
	await assert.rejects(
		store.ingest(deviceCaller, policy.revision, [
			{
				...event("unapproved", policy.revision),
				capture: {
					revision: policy.revision,
					basis: "repository",
					reference: "github.com/other/company",
				},
			},
		]),
		errorCode("forbidden"),
	);
	await assert.rejects(
		store.updateRepositories(memberCaller, []),
		errorCode("forbidden"),
	);
	await assert.rejects(
		store.updateOwnPolicy(deviceCaller, { accounts: [], locations: [] }),
		errorCode("forbidden"),
	);
	const changed = await store.updateOwnPolicy(memberCaller, {
		accounts: [
			{
				source: "claude",
				accountId: "synthetic-account",
				organizationId: null,
			},
		],
		locations: ["/synthetic/research"],
	});
	assert.equal(changed.revision, policy.revision + 1);
	assert.deepEqual(await store.getPolicy(deviceCaller), changed);
	await assert.rejects(
		store.ingest(deviceCaller, policy.revision, [
			event("stale", policy.revision),
		]),
		errorCode("policy_changed"),
	);
	await assert.rejects(
		store.ingest(deviceCaller, changed.revision, [
			event("old-proof", policy.revision),
		]),
		errorCode("forbidden"),
	);
	const current = {
		...event("research", changed.revision),
		capture: {
			revision: changed.revision,
			basis: "location" as const,
			reference: "/synthetic/research",
		},
	};
	assert.equal(
		(await store.ingest(deviceCaller, changed.revision, [current]))
			.insertedCount,
		1,
	);
	const result = await Promise.allSettled([
		store.ingest(deviceCaller, changed.revision, [
			event("racing", changed.revision),
		]),
		store.updateRepositories(adminCaller, []),
	]);
	assert.equal(result[1]?.status, "fulfilled");
	if (result[0]?.status === "rejected")
		assert.ok(errorCode("policy_changed")(result[0].reason));
	assert.equal(
		(await store.getPolicy(deviceCaller)).revision,
		changed.revision + 1,
	);
});

test("vault owner isolation, revocation, disabled-member retention, and secret-free audit", {
	skip: !databaseUrl,
}, async (context) => {
	const {
		store,
		member,
		initial,
		adminCaller,
		memberCaller,
		deviceCaller,
		device,
		policy,
	} = await fixture(context);
	await store.ingest(deviceCaller, policy.revision, [
		event("retained", policy.revision),
	]);
	await store.createInvitation(
		adminCaller,
		{ email: "coworker@example.test", name: "Coworker", role: "member" },
		token("coworker-invite"),
	);
	await store.redeemInvitation(
		tokenHash("coworker-invite"),
		"coworker-hash",
		token("coworker"),
	);
	const coworker = caller("coworker");
	const identity = {
		memberId: member.id,
		source: "claude" as const,
		sourceSessionId: "source-session",
	};
	assert.deepEqual((await store.listSessions(coworker)).items, []);
	assert.deepEqual((await store.readEvents(coworker, null)).items, []);
	const session = await store.getSession(memberCaller, identity);
	await assert.rejects(
		store.getSessionById(coworker, session.id),
		errorCode("not_found"),
	);
	assert.equal(
		(await store.getSessionById(adminCaller, session.id)).memberId,
		member.id,
	);
	await assert.rejects(
		store.getSession(coworker, identity),
		errorCode("forbidden"),
	);
	await assert.rejects(
		store.readEvents(coworker, identity),
		errorCode("forbidden"),
	);
	await assert.rejects(
		store.deleteSession(coworker, identity),
		errorCode("forbidden"),
	);
	await assert.rejects(
		store.revokeDevice(coworker, device.id),
		errorCode("forbidden"),
	);
	await assert.rejects(store.listAudit(memberCaller), errorCode("forbidden"));
	await store.updateMember(adminCaller, member.id, {
		disabled: true,
	});
	await assert.rejects(store.me(memberCaller), errorCode("unauthorized"));
	await assert.rejects(
		store.getPolicy(deviceCaller),
		errorCode("unauthorized"),
	);
	await assert.rejects(
		store.ingest(deviceCaller, policy.revision, [
			event("disabled", policy.revision),
		]),
		errorCode("unauthorized"),
	);
	assert.equal((await store.readEvents(adminCaller, identity)).items.length, 1);
	assert.equal((await store.listSessions(adminCaller)).items.length, 1);
	await store.updateMember(adminCaller, member.id, {
		role: "member",
		disabled: false,
	});
	await assert.rejects(store.me(memberCaller), errorCode("unauthorized"));
	await store.login(
		"member@example.test",
		async (hash) => hash === "synthetic-member-password-hash",
		token("member-new"),
	);
	await store.enrollDevice(caller("member-new"), {
		source: "codex",
		name: "New",
		tokenHash: tokenHash("fresh-device"),
	});
	await assert.rejects(
		store.getPolicy(deviceCaller),
		errorCode("unauthorized"),
	);
	const audit = await store.listAudit(adminCaller, { limit: 1 });
	assert.equal(audit.items.length, 1);
	assert.ok(audit.nextCursor);
	const actions = (await store.listAudit(adminCaller)).items;
	assert.ok(
		actions.some(
			(row) =>
				row.action === "member.updated" &&
				row.targetId === member.id &&
				row.actorId === initial.id,
		),
	);
	assert.equal(JSON.stringify(actions).includes("password"), false);
	assert.equal(JSON.stringify(actions).includes(tokenHash("device")), false);
});

test("vault deletion tombstones survive retry, enrollment changes, and source/session identity reuse", {
	skip: !databaseUrl,
}, async (context) => {
	const {
		store,
		member,
		adminCaller,
		memberCaller,
		deviceCaller,
		device,
		policy,
	} = await fixture(context);
	const original = event("deleted-event", policy.revision);
	await store.ingest(deviceCaller, policy.revision, [original]);
	const identity = {
		memberId: member.id,
		source: "claude" as const,
		sourceSessionId: original.sessionId,
	};
	await store.deleteSession(memberCaller, identity);
	assert.deepEqual((await store.readEvents(adminCaller, null)).items, []);
	assert.deepEqual((await store.listSessions(memberCaller)).items, []);
	await assert.rejects(
		store.getSession(memberCaller, identity),
		errorCode("not_found"),
	);
	await store.revokeDevice(memberCaller, device.id);
	await assert.rejects(
		store.ingest(deviceCaller, policy.revision, [original]),
		errorCode("unauthorized"),
	);
	await store.enrollDevice(memberCaller, {
		source: "claude",
		name: "Reenrolled",
		tokenHash: tokenHash("replacement"),
	});
	const replacement = caller("replacement", "device");
	assert.deepEqual(
		await store.ingest(replacement, policy.revision, [original]),
		{ acceptedEventIds: [original.eventId], insertedCount: 0 },
	);
	assert.equal(
		(
			await store.ingest(replacement, policy.revision, [
				{ ...original, sessionId: "renamed-session" },
			])
		).insertedCount,
		0,
	);
	assert.equal(
		(
			await store.ingest(replacement, policy.revision, [
				event("new-id-deleted-session", policy.revision),
			])
		).insertedCount,
		0,
	);
	await store.enrollDevice(memberCaller, {
		source: "codex",
		name: "Other source",
		tokenHash: tokenHash("codex"),
	});
	assert.equal(
		(await store.ingest(caller("codex", "device"), policy.revision, [original]))
			.insertedCount,
		1,
	);
	await store.deleteSession(adminCaller, { ...identity, source: "codex" });
	await store.deleteSession(memberCaller, identity);
	assert.deepEqual((await store.readEvents(adminCaller, null)).items, []);
	assert.ok(
		(await store.listAudit(adminCaller)).items.some(
			(row) => row.action === "session.deleted",
		),
	);
});

test("vault concurrent bootstrap and invitation redemption have exactly one winner", {
	skip: !databaseUrl,
}, async (context) => {
	const { store, adminCaller } = await fixture(context, true);
	await store.createInvitation(
		adminCaller,
		{ email: "race@example.test", name: "Race", role: "admin" },
		token("race-invite"),
	);
	const redeemed = await Promise.allSettled([
		store.redeemInvitation(tokenHash("race-invite"), "hash-1", token("race-1")),
		store.redeemInvitation(tokenHash("race-invite"), "hash-2", token("race-2")),
	]);
	assert.equal(
		redeemed.filter((result) => result.status === "fulfilled").length,
		1,
	);
	assert.equal(
		redeemed.filter(
			(result) =>
				result.status === "rejected" &&
				errorCode("unauthorized")(result.reason),
		).length,
		1,
	);
	const invitedAdmin = redeemed.find((result) => result.status === "fulfilled");
	assert.equal(
		invitedAdmin?.status === "fulfilled" && invitedAdmin.value.role,
		"admin",
	);
});

test("vault timeline cursors preserve sequence order and stable ties, and invitations expire or revoke", {
	skip: !databaseUrl,
}, async (context) => {
	const {
		store,
		pool,
		adminCaller,
		memberCaller,
		deviceCaller,
		member,
		policy,
	} = await fixture(context);
	await store.ingest(deviceCaller, policy.revision, [
		{ ...event("later", policy.revision), sequence: 7 },
		{ ...event("tie-z", policy.revision), sequence: 2 },
		{ ...event("tie-a", policy.revision), sequence: 2 },
	]);
	const identity = {
		memberId: member.id,
		source: "claude" as const,
		sourceSessionId: "source-session",
	};
	const first = await store.readEvents(memberCaller, identity, { limit: 1 });
	assert.equal(first.items[0]?.eventId, "tie-a");
	assert.ok(first.nextCursor);
	const second = await store.readEvents(memberCaller, identity, {
		limit: 1,
		after: first.nextCursor,
	});
	assert.equal(second.items[0]?.eventId, "tie-z");
	assert.ok(second.nextCursor);
	const third = await store.readEvents(memberCaller, identity, {
		limit: 1,
		after: second.nextCursor,
	});
	assert.equal(third.items[0]?.eventId, "later");
	assert.equal(third.nextCursor, null);
	assert.equal((await store.getSession(memberCaller, identity)).eventCount, 3);
	await assert.rejects(
		store.readEvents(memberCaller, identity, { after: "garbage" }),
		errorCode("invalid_input"),
	);
	await assert.rejects(
		store.listSessions(memberCaller, { after: "garbage" }),
		errorCode("invalid_input"),
	);
	const invite = await store.createInvitation(
		adminCaller,
		{ email: "revoked@example.test", name: "Revoked", role: "member" },
		token("revoked-invite"),
	);
	await store.revokeInvitation(adminCaller, invite.id);
	await assert.rejects(
		store.redeemInvitation(
			tokenHash("revoked-invite"),
			"hash",
			token("revoked-session"),
		),
		errorCode("unauthorized"),
	);
	await store.createInvitation(
		adminCaller,
		{ email: "expired@example.test", name: "Expired", role: "member" },
		token("expired-invite"),
	);
	await pool.query(
		"UPDATE vault.invitations SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
		[tokenHash("expired-invite")],
	);
	await assert.rejects(
		store.redeemInvitation(
			tokenHash("expired-invite"),
			"hash",
			token("expired-session"),
		),
		errorCode("unauthorized"),
	);
});
