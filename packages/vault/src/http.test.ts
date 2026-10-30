import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";
import * as z from "zod";
import { createVaultServer } from "./http.js";
import { migrateVault } from "./migrate.js";
import { VaultStore } from "./store.js";

const databaseUrl = process.env.VAULT_TEST_DATABASE_URL;
const authSchema = z.object({
	token: z.string(),
	member: z.object({ id: z.string(), role: z.string() }),
});
const policySchema = z.object({ revision: z.number() });
const enrollmentSchema = z.object({
	token: z.string(),
	deviceId: z.string(),
	organizationId: z.uuid(),
});
const sessionsSchema = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			eventCount: z.number(),
			contributorName: z.string(),
		}),
	),
});

test("standalone HTTP vault enforces private archives, stale-policy rejection and company retention", {
	skip: !databaseUrl,
}, async (context) => {
	assert.ok(databaseUrl);
	const database = new URL(databaseUrl);
	assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
	const admin = new Pool({ connectionString: databaseUrl });
	const databaseName = `vault_http_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`CREATE DATABASE "${databaseName}"`);
	database.pathname = `/${databaseName}`;
	const store = new VaultStore(database.toString());
	const bootstrapToken = "synthetic-bootstrap-token-longer-than-thirty-two";
	const server = createVaultServer(store, {
		publicUrl: "http://localhost:4310",
		bootstrapToken,
		publicDirectory: "/unused-test-assets",
	});
	context.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await store.close();
		await admin.query(`DROP DATABASE "${databaseName}"`);
		await admin.end();
	});
	await migrateVault(
		database.toString(),
		fileURLToPath(new URL("../migrations", import.meta.url)),
	);
	await migrateVault(
		database.toString(),
		fileURLToPath(new URL("../migrations", import.meta.url)),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = z.object({ port: z.number() }).parse(server.address());
	const origin = `http://127.0.0.1:${address.port}`;
	const request = (
		route: string,
		token?: string,
		value?: unknown,
		method = value === undefined ? "GET" : "POST",
		headers: Record<string, string> = {},
	) =>
		fetch(origin + route, {
			method,
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(value === undefined ? {} : { "Content-Type": "application/json" }),
				...headers,
			},
			...(value === undefined ? {} : { body: JSON.stringify(value) }),
		});
	assert.equal((await request("/ready")).status, 200);
	assert.equal((await request("/api/sessions")).status, 401);
	const setup = {
		bootstrapToken,
		name: "Company",
		email: "admin@example.test",
		displayName: "Admin",
		password: "synthetic-password-only",
	};
	assert.equal(
		(
			await request("/api/setup", undefined, {
				...setup,
				bootstrapToken: "wrong-bootstrap-token-longer-than-thirty-two",
			})
		).status,
		403,
	);
	const response = await request("/api/setup", undefined, setup);
	assert.equal(response.status, 200);
	assert.match(
		response.headers.get("set-cookie") ?? "",
		/HttpOnly; SameSite=Strict/,
	);
	const owner = authSchema.parse(await response.json());
	assert.equal((await request("/api/setup", undefined, setup)).status, 409);
	assert.equal(
		(
			await request("/api/auth/login", undefined, {
				email: setup.email,
				password: "wrong",
			})
		).status,
		401,
	);
	assert.equal(
		(
			await request(
				"/api/auth/login",
				undefined,
				{ email: setup.email, password: setup.password },
				"POST",
				{ Origin: "https://attacker.example" },
			)
		).status,
		403,
	);
	const invite = await request("/api/invitations", owner.token, {
		email: "engineer@example.test",
		name: "Engineer",
		role: "member",
	});
	assert.equal(invite.status, 201);
	const invitation = z
		.object({ invitationToken: z.string() })
		.parse(await invite.json());
	const joined = await request("/api/auth/join", undefined, {
		token: invitation.invitationToken,
		password: setup.password,
	});
	assert.equal(joined.status, 200);
	const member = authSchema.parse(await joined.json());
	assert.equal(
		(
			await request("/api/auth/join", undefined, {
				token: invitation.invitationToken,
				password: setup.password,
			})
		).status,
		401,
	);
	assert.equal((await request("/api/members", member.token)).status, 403);
	const policyResponse = await request(
		"/api/settings/policy",
		owner.token,
		{ repositories: ["git@github.com:company/project.git"] },
		"PUT",
	);
	assert.equal(policyResponse.status, 200);
	const policy = policySchema.parse(await policyResponse.json());
	const enrolled = await request("/api/collector/enroll", member.token, {
		deviceName: "Laptop",
		source: "claude",
	});
	assert.equal(enrolled.status, 200);
	const device = enrollmentSchema.parse(await enrolled.json());
	assert.equal((await request("/api/sessions", device.token)).status, 403);
	const event = {
		eventId: "synthetic-event",
		sessionId: "original-session",
		sequence: 0,
		callId: null,
		projectId: null,
		occurredAt: "2026-01-01T00:00:00.000Z",
		eventType: "user_message",
		payload: { text: "Keep the full original content", cwd: "/work/project" },
		capture: {
			revision: policy.revision,
			basis: "repository",
			reference: "github.com/company/project",
		},
	};
	const ingest = () =>
		request("/api/traces/ingest", device.token, { events: [event] });
	assert.equal((await ingest()).status, 202);
	assert.equal((await ingest()).status, 202);
	const listed = sessionsSchema.parse(
		await (await request("/api/sessions", member.token)).json(),
	);
	assert.equal(listed.items.length, 1);
	assert.equal(listed.items[0]?.eventCount, 1);
	assert.equal(listed.items[0]?.contributorName, "Engineer");
	const sessionId = listed.items[0]!.id;
	const exported = await request(
		`/api/sessions/${sessionId}/export`,
		member.token,
	);
	assert.equal(exported.status, 200);
	assert.deepEqual(JSON.parse((await exported.text()).trim()), event);
	const secondInvite = z.object({ invitationToken: z.string() }).parse(
		await (
			await request("/api/invitations", owner.token, {
				email: "second@example.test",
				name: "Other member",
				role: "member",
			})
		).json(),
	);
	const second = authSchema.parse(
		await (
			await request("/api/auth/join", undefined, {
				token: secondInvite.invitationToken,
				password: setup.password,
			})
		).json(),
	);
	assert.equal(
		sessionsSchema.parse(
			await (await request("/api/sessions", second.token)).json(),
		).items.length,
		0,
	);
	assert.equal(
		(await request(`/api/sessions/${sessionId}/events`, second.token)).status,
		404,
	);
	assert.equal(
		(await request(`/api/sessions/${sessionId}/export`, second.token)).status,
		404,
	);
	assert.equal(
		(
			await request(
				"/api/settings/policy",
				owner.token,
				{ repositories: [] },
				"PUT",
			)
		).status,
		200,
	);
	assert.equal((await ingest()).status, 409);
	assert.equal(
		(
			await request(
				`/api/members/${member.member.id}`,
				owner.token,
				{ disabled: true },
				"PATCH",
			)
		).status,
		204,
	);
	assert.equal((await request("/api/sessions", member.token)).status, 401);
	assert.equal(
		(await request("/api/collector/policy", device.token)).status,
		401,
	);
	assert.equal(
		sessionsSchema.parse(
			await (await request("/api/sessions", owner.token)).json(),
		).items.length,
		1,
	);
	assert.equal(
		(
			await request(
				`/api/sessions/${sessionId}`,
				owner.token,
				undefined,
				"DELETE",
			)
		).status,
		204,
	);
	assert.equal(
		sessionsSchema.parse(
			await (await request("/api/sessions", owner.token)).json(),
		).items.length,
		0,
	);
});
