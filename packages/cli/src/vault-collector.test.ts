import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
	parseTraceEventBatch,
	permitsVaultCapture,
	type CollectorSource,
	type TraceEvent,
	type VaultCapturePolicy,
} from "iteration-trace-contracts";
import { collectorTick, scanSourceOnce } from "./collector.js";
import {
	appendEvents,
	collectorPaths,
	loadConfig,
	loadState,
	nextBatch,
	outboxSize,
	prepareSourceInitialState,
	saveConfig,
	saveState,
	type CollectorConfig,
} from "./storage.js";
import { vaultOrigin } from "./vault-api.js";
import {
	enrollVault,
	vaultMemberLogin,
	type VaultPrompts,
} from "./vault-enrollment.js";
import { authorizeVaultRecord } from "./vault-scope.js";
import {
	CLAUDE_ACCOUNT_VERSION,
	ClaudeAccountIndex,
	loadClaudeAccountLedger,
	saveClaudeAccountEvidence,
	type ClaudeAccountEvidence,
} from "./claude-account.js";
import {
	claudeMetadataFromOtlp,
	startClaudeAccountReceiver,
} from "./claude-account-receiver.js";
import {
	approveClaudeAccount,
	setupClaudeAccount,
} from "./claude-account-setup.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const DEVICE_ID = "22222222-2222-4333-8444-555555555555";
const DEVICE_TOKEN = `vd_${"d".repeat(43)}`;
const MEMBER_TOKEN = `vs_${"m".repeat(43)}`;
const PASSWORD = "fixture-native-password";
const EMPTY_POLICY: VaultCapturePolicy = {
	revision: 1,
	repositories: [],
	accounts: [],
	locations: [],
};
const run = promisify(execFile);

async function fixture(
	context: TestContext,
	source: CollectorSource = "claude",
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-cli-test-"));
	context.after(() => fs.rm(root, { recursive: true, force: true }));
	const home = path.join(root, source);
	const directory = path.join(root, "collector");
	const paths = collectorPaths(directory);
	const scope = path.join(root, "work");
	await fs.mkdir(scope, { recursive: true });
	const service = {
		policy: { ...EMPTY_POLICY, locations: [scope] } as VaultCapturePolicy,
		events: [] as TraceEvent[],
		requests: [] as {
			route: string;
			authorization: string | undefined;
			body: unknown;
		}[],
		rejectPolicy: false,
	};
	const server = http.createServer(async (request, response) => {
		try {
			let text = "";
			for await (const chunk of request) text += String(chunk);
			const body: unknown = text ? JSON.parse(text) : null;
			const route = request.url ?? "";
			service.requests.push({
				route,
				authorization: request.headers.authorization,
				body,
			});
			response.setHeader("content-type", "application/json");
			if (route === "/api/auth/login" || route === "/api/auth/join") {
				response.end(
					JSON.stringify({ token: MEMBER_TOKEN, member: { id: SESSION_ID } }),
				);
			} else if (route === "/api/collector/enroll") {
				assert.equal(request.headers.authorization, `Bearer ${MEMBER_TOKEN}`);
				response.end(
					JSON.stringify({
						status: "enrolled",
						token: DEVICE_TOKEN,
						deviceId: DEVICE_ID,
						organizationId: SESSION_ID,
						organizationName: "Fixture company",
					}),
				);
			} else if (
				route === "/api/me/capture-rules" ||
				route === "/api/collector/policy"
			) {
				if (request.method === "PUT") {
					const updated = body as Pick<
						VaultCapturePolicy,
						"locations" | "accounts"
					>;
					service.policy = {
						...service.policy,
						...updated,
						revision: service.policy.revision + 1,
					};
				}
				response.end(JSON.stringify(service.policy));
			} else if (route === "/api/traces/ingest") {
				assert.equal(request.headers.authorization, `Bearer ${DEVICE_TOKEN}`);
				const parsed = parseTraceEventBatch(body);
				assert.ok(parsed.success);
				if (
					service.rejectPolicy ||
					parsed.value.events.some(
						(event) =>
							!event.capture ||
							!permitsVaultCapture(service.policy, event.capture),
					)
				) {
					response.statusCode = 409;
					response.end(JSON.stringify({ error: "policy_changed" }));
				} else {
					service.events.push(...parsed.value.events);
					response.statusCode = 202;
					response.end(
						JSON.stringify({
							deviceId: DEVICE_ID,
							acceptedEventIds: parsed.value.events.map(
								(event) => event.eventId,
							),
						}),
					);
				}
			} else {
				response.statusCode = 404;
				response.end("{}");
			}
		} catch {
			response.statusCode = 500;
			response.end("{}");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	context.after(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	);
	const address = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${address.port}`;
	const common = {
		endpoint: `${origin}/api/traces/ingest`,
		token: DEVICE_TOKEN,
		destination: "vault" as const,
		dataDirectory: directory,
	};
	const config: CollectorConfig =
		source === "codex"
			? { ...common, codexHome: home }
			: source === "claude"
				? { ...common, source, claudeHome: home }
				: { ...common, source, cursorHome: home };
	await saveState(await prepareSourceInitialState(source, home, true), paths);
	return { root, home, directory, paths, scope, service, origin, config };
}

async function writeRecords(filename: string, records: readonly unknown[]) {
	await fs.mkdir(path.dirname(filename), { recursive: true });
	const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
	await fs.writeFile(filename, text);
	return text;
}

function claude(cwd: string | undefined, text: string, uuid: string) {
	return {
		type: "user",
		sessionId: SESSION_ID,
		uuid,
		cwd,
		timestamp: "2026-10-01T00:00:00Z",
		message: { role: "user", content: text },
	};
}

test("native enrollment keeps only device credentials and uploads only selected mixed Claude records through the real transport", async (context) => {
	const f = await fixture(context);
	// Enrollment requires a fresh directory, unlike an already initialized scanner.
	await fs.rm(f.directory, { recursive: true, force: true });
	const filename = path.join(
		f.home,
		"projects",
		"project",
		`${SESSION_ID}.jsonl`,
	);
	const original = await writeRecords(filename, [
		claude(
			f.scope,
			"company selected api_key=companyfixturesecret123456789",
			"work",
		),
		claude(`${f.scope}-private`, "personal rejected", "private"),
		claude(undefined, "unknown rejected", "unknown"),
		claude(f.scope, "second company selected", "work-again"),
	]);
	let approvals = 0;
	const prompts: VaultPrompts = {
		text: async () => "employee@example.test",
		secret: async () => PASSWORD,
		approve: async (description) => {
			approvals++;
			assert.match(description, /existing history/);
			assert.match(
				description,
				/Claude account capture requires explicit metadata-only/,
			);
			return true;
		},
	};
	await enrollVault(
		{
			origin: f.origin,
			source: "claude",
			home: f.home,
			directory: f.directory,
			join: false,
			locations: [],
		},
		prompts,
	);
	assert.equal(approvals, 1);
	const saved = await fs.readFile(f.paths.config, "utf8");
	assert.ok(!saved.includes(PASSWORD) && !saved.includes(MEMBER_TOKEN));
	if (process.platform !== "win32") {
		assert.equal((await fs.stat(f.paths.config)).mode & 0o777, 0o600);
		assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
	}
	const config = await loadConfig(f.paths);
	const scan = await scanSourceOnce(
		config,
		f.paths,
		undefined,
		f.service.policy,
	);
	assert.equal(scan.excludedRecords, 2);
	const queued = await fs.readFile(f.paths.outbox, "utf8");
	assert.match(queued, /company selected/);
	assert.ok(
		!queued.includes("personal rejected") &&
			!queued.includes("unknown rejected"),
	);
	assert.ok(!queued.includes("companyfixturesecret123456789"));
	const result = await collectorTick(config, f.paths);
	assert.ok(result.uploaded > 0);
	assert.equal(await outboxSize(f.paths), 0);
	assert.equal(
		f.service.events.filter((event) => event.eventType === "user_message")
			.length,
		2,
	);
	assert.equal(await fs.readFile(filename, "utf8"), original);
	assert.deepEqual(
		f.service.requests.find((request) => request.route === "/api/auth/login")
			?.body,
		{ email: "employee@example.test", password: PASSWORD },
	);
	assert.ok(
		f.service.requests.every((request) => request.route.startsWith("/api/")),
	);
});

test("Codex resumes and new tasks cannot inherit launch or previous-turn permission, including across collector restarts", async (context) => {
	const f = await fixture(context, "codex");
	const filename = path.join(f.home, "sessions", `rollout-${SESSION_ID}.jsonl`);
	const message = (text: string) => ({
		type: "response_item",
		payload: {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text }],
		},
	});
	await writeRecords(filename, [
		{
			type: "session_meta",
			payload: { id: SESSION_ID, cwd: f.scope, creator_account_id: "company" },
		},
		message("unknown after launch rejected"),
		{ type: "event_msg", payload: { type: "task_started", turn_id: "work" } },
		{ type: "turn_context", payload: { cwd: f.scope } },
		message("selected company turn"),
	]);
	await collectorTick(f.config, f.paths);
	await fs.appendFile(
		filename,
		`${[
			{
				type: "event_msg",
				payload: { type: "task_started", turn_id: "resume" },
			},
			message("resumed unknown rejected"),
			{ type: "turn_context", payload: { cwd: `${f.scope}-private` } },
			message("resumed personal rejected"),
			{
				type: "event_msg",
				payload: { type: "task_started", turn_id: "work2" },
			},
			{ type: "turn_context", payload: { cwd: f.scope } },
			message("selected subsequent company turn"),
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`,
	);
	await collectorTick(f.config, f.paths);
	const uploaded = JSON.stringify(f.service.events);
	assert.match(uploaded, /selected company turn/);
	assert.match(uploaded, /selected subsequent company turn/);
	assert.ok(!uploaded.includes("unknown after launch rejected"));
	assert.ok(!uploaded.includes("resumed unknown rejected"));
	assert.ok(!uploaded.includes("resumed personal rejected"));
});

test("changed policy drops old and unscoped queued content before upload and automatically reevaluates rejected history", async (context) => {
	const f = await fixture(context);
	const filename = path.join(
		f.home,
		"projects",
		"project",
		`${SESSION_ID}.jsonl`,
	);
	const privateRoot = `${f.scope}-private`;
	await writeRecords(filename, [
		claude(f.scope, "old-company-now-revoked", "work"),
		claude(privateRoot, "newly-approved-history", "private"),
	]);
	await scanSourceOnce(f.config, f.paths, undefined, f.service.policy);
	await appendEvents(
		[
			{
				eventId: "old-unscoped",
				sessionId: SESSION_ID,
				sequence: 0,
				callId: null,
				projectId: null,
				occurredAt: null,
				eventType: "user_message",
				payload: { text: "unscoped-never-upload" },
			},
		],
		f.paths,
	);
	f.service.policy = { ...EMPTY_POLICY, revision: 2, locations: [privateRoot] };
	await collectorTick(f.config, f.paths);
	assert.match(JSON.stringify(f.service.events), /newly-approved-history/);
	assert.ok(
		!JSON.stringify(f.service.events).includes("old-company-now-revoked"),
	);
	assert.ok(
		!JSON.stringify(f.service.events).includes("unscoped-never-upload"),
	);
	assert.ok(f.service.events.every((event) => event.capture?.revision === 2));
	assert.equal(await outboxSize(f.paths), 0);
});

test("409 stops upload; the next attempt fetches policy before sending and never retries revoked content", async (context) => {
	const f = await fixture(context);
	await writeRecords(
		path.join(f.home, "projects", "project", `${SESSION_ID}.jsonl`),
		[claude(f.scope, "queued-before-policy-race", "work")],
	);
	f.service.rejectPolicy = true;
	await assert.rejects(collectorTick(f.config, f.paths), /HTTP 409/);
	assert.ok((await outboxSize(f.paths)) > 0);
	const boundary = f.service.requests.length;
	f.service.policy = { ...EMPTY_POLICY, revision: 2 };
	f.service.rejectPolicy = false;
	await collectorTick(f.config, f.paths);
	assert.equal(f.service.requests[boundary]?.route, "/api/collector/policy");
	assert.equal(f.service.events.length, 0);
	assert.equal(await outboxSize(f.paths), 0);
});

test("repository evidence follows git worktrees while location paths reject siblings and symlink escapes", async (context) => {
	const f = await fixture(context);
	const common = path.join(f.root, "main", ".git");
	const worktreeGit = path.join(common, "worktrees", "feature");
	await fs.mkdir(worktreeGit, { recursive: true });
	await fs.writeFile(
		path.join(common, "config"),
		'[remote "origin"]\n url = git@github.com:Company/Repo.git\n',
	);
	await fs.writeFile(path.join(worktreeGit, "commondir"), "../..\n");
	await fs.writeFile(path.join(f.scope, ".git"), `gitdir: ${worktreeGit}\n`);
	f.service.policy = {
		...EMPTY_POLICY,
		repositories: ["github.com/company/repo"],
	};
	const filename = path.join(
		f.home,
		"projects",
		"project",
		`${SESSION_ID}.jsonl`,
	);
	await writeRecords(filename, [
		claude(f.scope, "worktree-selected", "work"),
		claude(`${f.scope}-private`, "sibling-rejected", "private"),
	]);
	await collectorTick(f.config, f.paths);
	assert.match(JSON.stringify(f.service.events), /worktree-selected/);
	assert.ok(!JSON.stringify(f.service.events).includes("sibling-rejected"));
	await fs.writeFile(
		path.join(common, "config"),
		'[remote "origin"]\n url = git@github.com:Personal/Private.git\n',
	);
	await fs.appendFile(
		filename,
		`${JSON.stringify(claude(f.scope, "changed-remote-rejected", "changed"))}\n`,
	);
	await collectorTick(f.config, f.paths);
	assert.ok(
		!JSON.stringify(f.service.events).includes("changed-remote-rejected"),
	);
	const privateRoot = path.join(f.root, "private");
	await fs.mkdir(privateRoot);
	await fs.symlink(
		privateRoot,
		path.join(f.scope, "escape"),
		process.platform === "win32" ? "junction" : "dir",
	);
	assert.equal(
		authorizeVaultRecord(
			{ ...EMPTY_POLICY, locations: [f.scope] },
			"claude",
			JSON.stringify(
				claude(path.join(f.scope, "escape", "missing"), "secret", "x"),
			),
			filename,
			{},
		),
		null,
	);
});

test("Cursor account/project labels do not grant permission; an explicitly selected transcript location imports its history", async (context) => {
	const f = await fixture(context, "cursor");
	const transcriptRoot = path.join(
		f.home,
		"projects",
		"company-looking-label",
		"agent-transcripts",
	);
	const filename = path.join(transcriptRoot, SESSION_ID, `${SESSION_ID}.jsonl`);
	await writeRecords(filename, [
		{
			role: "user",
			user_email: "employee@example.test",
			message: {
				content: [
					{ type: "text", text: "cursor-selected-only-by-explicit-root" },
				],
			},
		},
	]);
	f.service.policy = {
		...EMPTY_POLICY,
		repositories: ["github.com/company/repo"],
		accounts: [
			{
				source: "cursor",
				accountId: "employee@example.test",
				organizationId: null,
			},
		],
	};
	await collectorTick(f.config, f.paths);
	assert.equal(f.service.events.length, 0);
	f.service.policy = {
		...f.service.policy,
		revision: 2,
		locations: [transcriptRoot],
	};
	await collectorTick(f.config, f.paths);
	assert.match(
		JSON.stringify(f.service.events),
		/cursor-selected-only-by-explicit-root/,
	);
	assert.ok(
		f.service.events.every((event) => event.capture?.basis === "location"),
	);
});

test("foreground one-shot CLI uses saved device credentials and reports actual selected uploads", async (context) => {
	const f = await fixture(context);
	await writeRecords(
		path.join(f.home, "projects", "project", `${SESSION_ID}.jsonl`),
		[
			claude(f.scope, "foreground-selected", "work"),
			claude(`${f.scope}-private`, "foreground-rejected", "private"),
		],
	);
	await saveConfig(f.config, f.paths);
	const { stdout, stderr } = await run(
		process.execPath,
		[
			"--import=tsx",
			"packages/cli/src/vault-cli.ts",
			"collect",
			"claude",
			"--data-directory",
			f.directory,
			"--once",
		],
		{ cwd: path.resolve(import.meta.dirname, "../../.."), timeout: 30_000 },
	);
	assert.equal(stderr, "");
	assert.match(stdout, /"uploaded":[1-9]/);
	assert.match(JSON.stringify(f.service.events), /foreground-selected/);
	assert.ok(!JSON.stringify(f.service.events).includes("foreground-rejected"));
	assert.ok(!stdout.includes(DEVICE_TOKEN));
	assert.equal(await outboxSize(f.paths), 0);
});

test("join redeems native invitation without persisting member secrets; insecure origins and unapproved enrollment fail closed", async (context) => {
	const f = await fixture(context);
	const prompts: VaultPrompts = {
		text: async () => "employee@example.test",
		secret: async (label) =>
			label.includes("Invitation") ? "fixture-invite" : PASSWORD,
		approve: async () => false,
	};
	assert.equal(await vaultMemberLogin(f.origin, prompts, true), MEMBER_TOKEN);
	assert.deepEqual(
		f.service.requests.find((request) => request.route === "/api/auth/join")
			?.body,
		{ token: "fixture-invite", password: PASSWORD },
	);
	for (const origin of [
		"http://vault.example.test",
		"https://user:secret@vault.example.test",
		"https://vault.example.test/path",
		"https://vault.example.test/?key=secret",
	])
		assert.throws(() => vaultOrigin(origin));
	await fs.rm(f.directory, { recursive: true, force: true });
	await assert.rejects(
		enrollVault(
			{
				origin: f.origin,
				source: "claude",
				home: f.home,
				directory: f.directory,
				join: false,
				locations: [],
			},
			prompts,
		),
		/cancelled/,
	);
	assert.ok(
		!f.service.requests.some(
			(request) => request.route === "/api/collector/enroll",
		),
	);
	await assert.rejects(fs.access(f.paths.config));
});

test("explicit local roots are registered with member auth and enable old history without account identity", async (context) => {
	const f = await fixture(context);
	f.service.policy = { ...EMPTY_POLICY };
	await fs.rm(f.directory, { recursive: true, force: true });
	await writeRecords(
		path.join(f.home, "projects", "project", `${SESSION_ID}.jsonl`),
		[claude(f.scope, "approved-local-history", "work")],
	);
	const prompts: VaultPrompts = {
		text: async () => "employee@example.test",
		secret: async () => PASSWORD,
		approve: async () => true,
	};
	const config = await enrollVault(
		{
			origin: f.origin,
			source: "claude",
			home: f.home,
			directory: f.directory,
			join: false,
			locations: [f.scope],
		},
		prompts,
	);
	const registration = f.service.requests.find(
		(request) =>
			request.route === "/api/me/capture-rules" && request.body !== null,
	);
	assert.deepEqual(registration?.body, { accounts: [], locations: [f.scope] });
	assert.equal(registration?.authorization, `Bearer ${MEMBER_TOKEN}`);
	await collectorTick(config, f.paths);
	assert.match(JSON.stringify(f.service.events), /approved-local-history/);
	assert.ok(f.service.events.every((event) => event.capture?.revision === 2));
});

test("ongoing foreground collection exits cleanly on SIGTERM and removes its device lock", async (context) => {
	const f = await fixture(context);
	await saveConfig(f.config, f.paths);
	await writeRecords(
		path.join(f.home, "projects", "project", `${SESSION_ID}.jsonl`),
		[claude(f.scope, "ongoing-selected", "work")],
	);
	const child = spawn(
		process.execPath,
		[
			"--import=tsx",
			"packages/cli/src/vault-cli.ts",
			"collect",
			"claude",
			"--data-directory",
			f.directory,
		],
		{
			cwd: path.resolve(import.meta.dirname, "../../.."),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	context.after(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		if (output.includes('"historyCaughtUp":true')) child.kill("SIGTERM");
	});
	let errors = "";
	child.stderr.on("data", (chunk: Buffer) => {
		errors += chunk.toString();
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Foreground collector did not terminate."));
		}, 30_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`Foreground collector exited ${code}: ${errors}`));
		});
	});
	assert.match(output, /"uploaded":[1-9]/);
	assert.match(JSON.stringify(f.service.events), /ongoing-selected/);
	await assert.rejects(fs.access(f.paths.lock));
});

test("account enrollment and password command-line arguments are rejected before any local history scan", async () => {
	const args = ["--import=tsx", "packages/cli/src/vault-cli.ts"];
	for (const source of ["codex", "cursor"]) {
		await assert.rejects(
			run(process.execPath, [...args, "approve-account", source]),
			(error: Error & { stderr?: string }) =>
				/Secure account-based capture is unsupported/.test(error.stderr ?? ""),
		);
	}
	await assert.rejects(
		run(process.execPath, [
			...args,
			"connect",
			"codex",
			"--password",
			"fixture-cli-password",
		]),
		(error: Error & { stderr?: string }) =>
			/Unknown option/.test(error.stderr ?? ""),
	);
});

test("current account labels never authorize historical Claude or Codex records and policy-less vault scanning is blocked", async (context) => {
	const f = await fixture(context);
	const policy: VaultCapturePolicy = {
		...EMPTY_POLICY,
		accounts: [
			{ source: "claude", accountId: "work", organizationId: "company" },
			{ source: "codex", accountId: "work", organizationId: null },
		],
	};
	assert.equal(
		authorizeVaultRecord(
			policy,
			"claude",
			JSON.stringify({
				...claude(f.scope, "private", "x"),
				accountId: "work",
				organizationId: "company",
			}),
			"/tmp/session.jsonl",
			{},
		),
		null,
	);
	assert.equal(
		authorizeVaultRecord(
			policy,
			"codex",
			JSON.stringify({
				type: "session_meta",
				payload: { cwd: f.scope, creator_account_id: "work" },
			}),
			"/tmp/rollout.jsonl",
			{},
		),
		null,
	);
	await assert.rejects(
		scanSourceOnce(f.config, f.paths),
		/current capture policy/,
	);
	assert.equal((await nextBatch(f.paths, 1024)).length, 0);
	assert.equal((await loadState(f.paths)).captureRevision, undefined);
});

const WORK_ACCOUNT = {
	source: "claude" as const,
	accountId: "33333333-2222-4333-8444-555555555555",
	organizationId: "44444444-2222-4333-8444-555555555555",
};
const USER_UUID = "55555555-2222-4333-8444-555555555555";
const ASSISTANT_UUID = "66666666-2222-4333-8444-555555555555";
const PROMPT_UUID = "77777777-2222-4333-8444-555555555555";
const PRIVATE_UUID = "88888888-2222-4333-8444-555555555555";

function otlp(
	records: readonly Readonly<Record<string, string>>[],
	version = CLAUDE_ACCOUNT_VERSION,
) {
	const attributes = (record: Readonly<Record<string, string>>) =>
		Object.entries(record).map(([key, stringValue]) => ({
			key,
			value: { stringValue },
		}));
	return {
		resourceLogs: [
			{
				resource: {
					attributes: attributes({
						"service.name": "claude-code",
						"service.version": version,
						"user.email": "do-not-persist-email@example.test",
					}),
				},
				scopeLogs: [
					{
						scope: { name: "com.anthropic.claude_code" },
						logRecords: records.map((record) => ({
							body: { stringValue: "do-not-persist-telemetry-body" },
							attributes: attributes(record),
						})),
					},
				],
			},
		],
	};
}

function telemetry(
	event: string,
	fields: Readonly<Record<string, string>> = {},
) {
	return {
		"event.name": event,
		"session.id": SESSION_ID,
		"prompt.id": PROMPT_UUID,
		"user.account_uuid": WORK_ACCOUNT.accountId,
		"organization.id": WORK_ACCOUNT.organizationId,
		prompt: "do-not-persist-prompt-content",
		response: "do-not-persist-response-content",
		tool_input: "do-not-persist-tool-content",
		...fields,
	};
}

function assistant(uuid: string, requestId: string, text: string) {
	return {
		type: "assistant",
		sessionId: SESSION_ID,
		uuid,
		requestId,
		timestamp: "2026-10-01T00:00:00Z",
		message: {
			role: "assistant",
			id: `msg_${uuid}`,
			model: "claude-sonnet-4-6",
			content: [{ type: "text", text }],
			usage: { input_tokens: 5, output_tokens: 7 },
		},
	};
}

test("Claude metadata-only OTLP joins late request identities to exact native messages outside repos without admitting mixed personal or historical records", async (context) => {
	const f = await fixture(context);
	f.service.policy = { ...EMPTY_POLICY, accounts: [WORK_ACCOUNT] };
	const filename = path.join(
		f.home,
		"projects",
		"mixed",
		`${SESSION_ID}.jsonl`,
	);
	const outside = path.join(f.root, "outside-repositories");
	const original = await writeRecords(filename, [
		claude(outside, "company outside-repo research prompt", USER_UUID),
		assistant(
			ASSISTANT_UUID,
			"req_company",
			"company outside-repo research answer",
		),
		claude(outside, "personal resumed prompt never selected", PRIVATE_UUID),
		assistant(
			"99999999-2222-4333-8444-555555555555",
			"req_private",
			"personal resumed answer never selected",
		),
		claude(
			outside,
			"historical unmatched prompt never selected",
			"aaaaaaaa-2222-4333-8444-555555555555",
		),
	]);
	const receiver = await startClaudeAccountReceiver(
		f.directory,
		0,
		"fixture-local-endpoint-secret",
	);
	context.after(() => receiver.close());
	const endpoint = `http://127.0.0.1:${receiver.port}/v1/logs/fixture-local-endpoint-secret`;
	const send = async (records: readonly Readonly<Record<string, string>>[]) => {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(otlp(records)),
		});
		assert.equal(response.status, 200, await response.text());
	};
	await collectorTick(f.config, f.paths);
	assert.equal(await outboxSize(f.paths), 0);
	await send([
		telemetry("user_prompt", {
			"message.uuid": USER_UUID,
			"user.account_uuid": "stale-personal-account",
			"organization.id": "stale-personal-org",
		}),
		telemetry("user_prompt", {
			"message.uuid": PRIVATE_UUID,
			"prompt.id": PRIVATE_UUID,
		}),
	]);
	await collectorTick(f.config, f.paths);
	assert.equal(
		f.service.events.length,
		0,
		"Early prompt identity is not authorization.",
	);
	assert.equal(await outboxSize(f.paths), 0);
	await send([
		telemetry("api_request", { request_id: "req_company" }),
		telemetry("assistant_response", {
			request_id: "req_company",
			"message.uuid": ASSISTANT_UUID,
		}),
		telemetry("api_request", {
			"prompt.id": PRIVATE_UUID,
			request_id: "req_private",
			"user.account_uuid": WORK_ACCOUNT.accountId,
			"organization.id": "different-personal-organization",
		}),
	]);
	await collectorTick(f.config, f.paths);
	const uploaded = JSON.stringify(f.service.events);
	assert.match(uploaded, /company outside-repo research prompt/);
	assert.match(uploaded, /company outside-repo research answer/);
	assert.ok(
		!uploaded.includes("personal resumed") &&
			!uploaded.includes("historical unmatched"),
	);
	assert.ok(
		f.service.events.some((event) => event.eventType === "token_usage_record"),
	);
	assert.ok(
		f.service.events.every((event) => event.capture?.basis === "account"),
	);
	const ledger = await fs.readFile(
		path.join(f.directory, "claude-account-ledger.json"),
		"utf8",
	);
	for (const forbidden of [
		"do-not-persist",
		"outside-repo research",
		"personal resumed",
		"stale-personal-account",
		"stale-personal-org",
	])
		assert.ok(!ledger.includes(forbidden), forbidden);
	assert.equal(await fs.readFile(filename, "utf8"), original);
	if (process.platform !== "win32")
		assert.equal(
			(await fs.stat(path.join(f.directory, "claude-account-ledger.json")))
				.mode & 0o777,
			0o600,
		);
});

test("Claude 2.1.282 tool results join native evidenced tool-use IDs across ticks without a newer OTLP request_id", async (context) => {
	const f = await fixture(context);
	f.service.policy = { ...EMPTY_POLICY, accounts: [WORK_ACCOUNT] };
	const filename = path.join(
		f.home,
		"projects",
		"mixed",
		`${SESSION_ID}.jsonl`,
	);
	const call = assistant(ASSISTANT_UUID, "req_tool", "unused");
	await writeRecords(filename, [
		{
			...call,
			message: {
				...call.message,
				content: [
					{
						type: "tool_use",
						id: "toolu_company",
						name: "WebSearch",
						input: { query: "company selected query" },
					},
				],
			},
		},
	]);
	const receiver = await startClaudeAccountReceiver(
		f.directory,
		0,
		"fixture-tool-secret",
	);
	context.after(() => receiver.close());
	const send = async (records: readonly Readonly<Record<string, string>>[]) => {
		const response = await fetch(
			`http://127.0.0.1:${receiver.port}/v1/logs/fixture-tool-secret`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(otlp(records, "2.1.282")),
			},
		);
		assert.equal(response.status, 200, await response.text());
	};
	await send([telemetry("api_request", { request_id: "req_tool" })]);
	await collectorTick(f.config, f.paths);
	assert.ok(f.service.events.some((event) => event.eventType === "tool_call"));
	const result = (uuid: string, toolId: string, text: string) => ({
		...claude(undefined, "", uuid),
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: toolId, content: text }],
		},
	});
	const selected = result(
		USER_UUID,
		"toolu_company",
		"company selected tool result",
	);
	const rejected = result(
		PRIVATE_UUID,
		"toolu_private",
		"personal rejected tool result",
	);
	const mixed = {
		...claude(undefined, "", "aaaaaaaa-2222-4333-8444-555555555555"),
		message: {
			role: "user",
			content: [...selected.message.content, ...rejected.message.content],
		},
	};
	await fs.appendFile(
		filename,
		`${JSON.stringify(selected)}\n${JSON.stringify(rejected)}\n${JSON.stringify(mixed)}\n`,
	);
	await send([
		telemetry("tool_result", { tool_use_id: "toolu_company" }),
		telemetry("tool_result", { tool_use_id: "toolu_private" }),
	]);
	f.service.rejectPolicy = true;
	await assert.rejects(collectorTick(f.config, f.paths), /HTTP 409/);
	const queued = await fs.readFile(f.paths.outbox, "utf8");
	assert.match(queued, /company selected tool result/);
	assert.ok(!queued.includes("personal rejected tool result"));
	const ledger = await fs.readFile(
		path.join(f.directory, "claude-account-ledger.json"),
		"utf8",
	);
	assert.ok(
		!ledger.includes("company selected query") &&
			!ledger.includes("tool result"),
	);
	await send([
		telemetry("assistant_response", {
			"message.uuid": ASSISTANT_UUID,
			request_id: "req_tool",
			"organization.id": "other-organization",
		}),
	]);
	f.service.rejectPolicy = false;
	await collectorTick(f.config, f.paths);
	assert.equal(await outboxSize(f.paths), 0);
	assert.ok(
		!JSON.stringify(f.service.events).includes("company selected tool result"),
	);
});

test("concurrent metadata writers preserve request evidence and failed writes do not poison the ledger", async (context) => {
	const f = await fixture(context);
	const rows = claudeMetadataFromOtlp(
		otlp([
			telemetry("api_request", { request_id: "req_concurrent_one" }),
			telemetry("api_request", { request_id: "req_concurrent_two" }),
		]),
	);
	await Promise.all(
		rows.map((row) => saveClaudeAccountEvidence(f.directory, [row])),
	);
	assert.deepEqual(
		(await loadClaudeAccountLedger(f.directory)).records
			.map((row) => row.requestId)
			.sort(),
		["req_concurrent_one", "req_concurrent_two"],
	);
	await assert.rejects(
		saveClaudeAccountEvidence(
			f.directory,
			Array.from({ length: 20_001 }, (_, offset) => ({
				...rows[0]!,
				requestId: `req_full_${offset}`,
			})),
		),
		/ledger is full/,
	);
	await saveClaudeAccountEvidence(f.directory, [
		{ ...rows[0]!, requestId: "req_after_failure" },
	]);
	assert.equal((await loadClaudeAccountLedger(f.directory)).records.length, 3);
});

test("account-scoped queued events are rechecked against both current policy and current exact evidence before upload", async (context) => {
	const f = await fixture(context);
	f.service.policy = { ...EMPTY_POLICY, accounts: [WORK_ACCOUNT] };
	await writeRecords(
		path.join(f.home, "projects", "mixed", `${SESSION_ID}.jsonl`),
		[assistant(ASSISTANT_UUID, "req_queue", "company queued by account")],
	);
	await saveClaudeAccountEvidence(
		f.directory,
		claudeMetadataFromOtlp(
			otlp([
				telemetry("assistant_response", {
					request_id: "req_queue",
					"message.uuid": ASSISTANT_UUID,
				}),
			]),
		),
	);
	f.service.rejectPolicy = true;
	await assert.rejects(collectorTick(f.config, f.paths), /HTTP 409/);
	assert.match(
		await fs.readFile(f.paths.outbox, "utf8"),
		/company queued by account/,
	);
	// Conflicting later evidence must not retain an earlier convenient account.
	await saveClaudeAccountEvidence(
		f.directory,
		claudeMetadataFromOtlp(
			otlp([
				telemetry("assistant_response", {
					request_id: "req_queue",
					"message.uuid": ASSISTANT_UUID,
					"organization.id": "other-organization",
				}),
			]),
		),
	);
	f.service.rejectPolicy = false;
	await collectorTick(f.config, f.paths);
	assert.equal(f.service.events.length, 0);
	assert.equal(await outboxSize(f.paths), 0);
	// Even valid evidence cannot override a removed owner-approved account rule.
	f.service.policy = { ...EMPTY_POLICY, revision: 2 };
	await collectorTick(f.config, f.paths);
	assert.equal(f.service.events.length, 0);
});

test("native metadata setup requires consent, preserves other settings, refuses existing exporters, and account approval uses observed identity", async (context) => {
	const f = await fixture(context);
	await fs.mkdir(f.home, { recursive: true });
	const filename = path.join(f.home, "settings.json");
	const original = {
		permissions: { allow: ["Read"] },
		env: {
			OTHER_SETTING: "kept",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
				"https://existing-exporter.example.test/v1/logs",
		},
	};
	await fs.writeFile(filename, JSON.stringify(original));
	const prompts: VaultPrompts = {
		text: async (label) =>
			label.includes("Number") ? "1" : "employee@example.test",
		secret: async () => PASSWORD,
		approve: async () => true,
	};
	await assert.rejects(
		setupClaudeAccount(f.config, prompts),
		/Existing .* conflicts/,
	);
	assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), original);
	await fs.writeFile(
		filename,
		JSON.stringify({
			permissions: original.permissions,
			env: { OTHER_SETTING: "kept" },
		}),
	);
	await assert.rejects(
		setupClaudeAccount(f.config, { ...prompts, approve: async () => false }),
		/cancelled/,
	);
	await setupClaudeAccount(f.config, prompts);
	const settings = JSON.parse(await fs.readFile(filename, "utf8")) as {
		permissions: unknown;
		env: Record<string, string>;
	};
	assert.deepEqual(settings.permissions, original.permissions);
	assert.equal(settings.env.OTHER_SETTING, "kept");
	for (const key of [
		"OTEL_LOG_USER_PROMPTS",
		"OTEL_LOG_ASSISTANT_RESPONSES",
		"OTEL_LOG_TOOL_DETAILS",
		"OTEL_LOG_TOOL_CONTENT",
		"OTEL_LOG_RAW_API_BODIES",
	])
		assert.equal(settings.env[key], "0");
	assert.equal(settings.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, "http/json");
	assert.match(
		settings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!,
		/^http:\/\/127\.0\.0\.1:4319\/v1\/logs\/[A-Za-z0-9_-]{43}$/,
	);
	assert.equal(settings.env.OTEL_METRICS_EXPORTER, "none");
	await assert.rejects(
		approveClaudeAccount(f.config, prompts),
		/No request-level Claude account identity observed/,
	);
	await saveClaudeAccountEvidence(
		f.directory,
		claudeMetadataFromOtlp(
			otlp([telemetry("api_request", { request_id: "req_approve" })]),
		),
	);
	await approveClaudeAccount(f.config, prompts);
	assert.deepEqual(f.service.policy.accounts, [WORK_ACCOUNT]);
});

test("receiver rejects unsupported versions, unauthorized requests and content-sized exports without retaining data", async (context) => {
	const f = await fixture(context);
	const receiver = await startClaudeAccountReceiver(
		f.directory,
		0,
		"fixture-secret",
	);
	context.after(() => receiver.close());
	const endpoint = `http://127.0.0.1:${receiver.port}/v1/logs/fixture-secret`;
	const send = (body: string, url = endpoint) =>
		fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
	assert.equal(
		(await send(JSON.stringify(otlp([telemetry("api_request")], "9.0.0"))))
			.status,
		422,
	);
	assert.equal(
		(
			await send(
				JSON.stringify(otlp([telemetry("api_request")])),
				`${endpoint}-wrong`,
			)
		).status,
		403,
	);
	const malformed = await send('{"do-not-leak-this-raw-content":');
	assert.equal(malformed.status, 422);
	assert.ok(!(await malformed.text()).includes("do-not-leak"));
	assert.equal(
		(await send(JSON.stringify({ content: "x".repeat(513 * 1024) }))).status,
		422,
	);
	assert.equal((await loadClaudeAccountLedger(f.directory)).records.length, 0);
	assert.throws(
		() => claudeMetadataFromOtlp(otlp([telemetry("api_request")], "2.1.266")),
		/unsupported/,
	);
});

test("metadata joins require exact session/message/request identifiers and ledger capacity and expiry are explicit", async (context) => {
	const f = await fixture(context);
	const rows = claudeMetadataFromOtlp(
		otlp([
			telemetry("api_request", { request_id: "req_exact" }),
			telemetry("assistant_response", {
				"message.uuid": ASSISTANT_UUID,
				request_id: "req_exact",
			}),
			telemetry("user_prompt", { "message.uuid": USER_UUID }),
		]),
	);
	const ledger = await saveClaudeAccountEvidence(f.directory, rows);
	const index = new ClaudeAccountIndex(ledger);
	const policy = { ...EMPTY_POLICY, accounts: [WORK_ACCOUNT] };
	assert.equal(
		index.authorize(policy, assistant(ASSISTANT_UUID, "req_exact", "work"))
			?.basis,
		"account",
	);
	assert.equal(
		index.authorize(policy, {
			...assistant(ASSISTANT_UUID, "req_exact", "private"),
			sessionId: PRIVATE_UUID,
		}),
		null,
	);
	assert.equal(
		index.authorize(
			policy,
			assistant(PRIVATE_UUID, "req_unrelated", "private"),
		),
		null,
	);
	assert.equal(
		index.authorize(
			{ ...policy, accounts: [{ ...WORK_ACCOUNT, organizationId: null }] },
			assistant(ASSISTANT_UUID, "req_exact", "private"),
		),
		null,
	);
	const expired = {
		...ledger,
		records: rows.map((row) => ({ ...row, receivedAt: 0 })),
	};
	await fs.writeFile(
		path.join(f.directory, "claude-account-ledger.json"),
		JSON.stringify(expired),
	);
	assert.equal((await loadClaudeAccountLedger(f.directory)).records.length, 0);
	const tooMany: ClaudeAccountEvidence[] = Array.from(
		{ length: 20_001 },
		(_, offset) => ({
			...rows[0]!,
			requestId: `req_${offset}`,
			receivedAt: Date.now(),
		}),
	);
	await assert.rejects(
		saveClaudeAccountEvidence(f.directory, tooMany),
		/ledger is full/,
	);
	assert.equal((await loadClaudeAccountLedger(f.directory)).records.length, 0);
});
