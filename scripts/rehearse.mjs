import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
	appendFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only synthetic data in uniquely named disposable Compose projects is touched.
const workspace = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "vault-release-"));
const prefix = `vault-proof-${randomBytes(5).toString("hex")}`;
const docker =
	process.env.VAULT_REHEARSAL_SUDO === "1" ? ["sudo", "docker"] : ["docker"];
const projects = [];
const password = "synthetic-rehearsal-password";
const adminEmail = "admin@example.test";
const memberEmail = "engineer@example.test";
const composeEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(
		([name]) => !name.startsWith("VAULT_") && !name.startsWith("COMPOSE_"),
	),
);

async function run(command, args, options = {}) {
	const child = spawn(command, args, {
		cwd: workspace,
		...options,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stdout = [];
	const stderr = [];
	child.stdout.on("data", (data) => stdout.push(data));
	child.stderr.on("data", (data) => stderr.push(data));
	const deadline = setTimeout(() => child.kill("SIGKILL"), 600_000);
	child.stdin.on("error", () => {});
	child.stdin.end(options.input);
	try {
		const [code] = await once(child, "exit");
		if (code !== 0)
			throw new Error(
				`${command} ${args[0] ?? ""} failed (${code}):\n${Buffer.concat(stderr).toString()}\n${Buffer.concat(stdout).toString()}`,
			);
		return Buffer.concat(stdout);
	} finally {
		clearTimeout(deadline);
	}
}

const container = (...args) =>
	run(docker[0], [...docker.slice(1), ...args], { env: composeEnvironment });
const compose = (project, ...args) =>
	container(
		"compose",
		"--project-name",
		project.name,
		"--env-file",
		project.env,
		"-f",
		"compose.yaml",
		...args,
	);

async function newProject(suffix) {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const port = listener.address().port;
	await new Promise((resolve, reject) =>
		listener.close((error) => (error ? reject(error) : resolve())),
	);
	const project = {
		name: `${prefix}-${suffix}`,
		env: path.join(scratch, `${suffix}.env`),
		origin: `http://localhost:${port}`,
		bootstrap: randomBytes(32).toString("hex"),
	};
	await writeFile(
		project.env,
		`VAULT_DATABASE_PASSWORD=${randomBytes(32).toString("hex")}\nVAULT_BOOTSTRAP_TOKEN=${project.bootstrap}\nVAULT_PUBLIC_URL=${project.origin}\nVAULT_PORT=${port}\nVAULT_IMAGE=trace-vault:rehearsal\n`,
		{ mode: 0o600 },
	);
	projects.push(project);
	return project;
}

async function request(
	project,
	route,
	token,
	value,
	method = value === undefined ? "GET" : "POST",
	status = 200,
	headers = {},
) {
	const response = await fetch(project.origin + route, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(value === undefined ? {} : { "Content-Type": "application/json" }),
			...headers,
		},
		...(value === undefined ? {} : { body: JSON.stringify(value) }),
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(response.status, status, `${method} ${route}`);
	return response;
}

async function json(...args) {
	return (await request(...args)).json();
}

async function interactive(command, args, answers) {
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const child = spawn(
		"script",
		["-qefc", [command, ...args].map(quote).join(" "), "/dev/null"],
		{ cwd: scratch, env: composeEnvironment, stdio: ["pipe", "pipe", "pipe"] },
	);
	let output = "";
	let index = 0;
	const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
		if (answers[index] && output.includes(answers[index][0])) {
			child.stdin.write(`${answers[index][1]}\n`);
			index++;
		}
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString();
	});
	try {
		const [code] = await once(child, "exit");
		assert.equal(
			code,
			0,
			`Interactive installed collector enrollment failed: ${output.replaceAll(password, "[hidden]")}`,
		);
		assert.equal(index, answers.length, "All private prompts were exercised");
	} finally {
		clearTimeout(deadline);
		child.stdin.end();
	}
}

try {
	process.stdout.write(
		"Building the shipping container and installing an independent collector tarball…\n",
	);
	const primary = await newProject("primary");
	await compose(primary, "build", "vault");
	await run("pnpm", [
		"--filter",
		"@useiteration/trace-vault-collector",
		"pack",
		"--pack-destination",
		scratch,
	]);
	const tarball = (await readdir(scratch)).find(
		(name) =>
			name.startsWith("useiteration-trace-vault-collector-") &&
			name.endsWith(".tgz"),
	);
	assert.ok(tarball);
	const install = path.join(scratch, "installed");
	await run("npm", [
		"install",
		"--prefix",
		install,
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		path.join(scratch, tarball),
	]);
	const cli = path.join(install, "node_modules", ".bin", "trace-vault");
	assert.match(
		(await run(cli, ["--help"], { cwd: scratch })).toString(),
		/Repository and location capture/,
	);
	await run("pnpm", [
		"--filter",
		"iteration-cli",
		"pack",
		"--pack-destination",
		scratch,
	]);
	const cliManifest = JSON.parse(
		await readFile(path.join(workspace, "packages/cli/package.json"), "utf8"),
	);
	const iterationInstall = path.join(scratch, "iteration-installed");
	await run("npm", [
		"install",
		"--prefix",
		iterationInstall,
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		path.join(scratch, `iteration-cli-${cliManifest.version}.tgz`),
	]);
	const iteration = path.join(
		iterationInstall,
		"node_modules",
		".bin",
		"iteration",
	);
	const iterationVault = path.join(
		iterationInstall,
		"node_modules",
		".bin",
		"trace-vault",
	);
	const iterationHome = path.join(scratch, "iteration-home");
	await mkdir(iterationHome);
	const isolatedIteration = {
		cwd: scratch,
		env: {
			...composeEnvironment,
			HOME: iterationHome,
			USERPROFILE: iterationHome,
			NODE_PATH: "",
			NODE_OPTIONS: "",
		},
	};
	assert.match(
		(await run(iteration, ["--help"], isolatedIteration)).toString(),
		/Iteration CLI/,
	);
	assert.equal(
		(await run(iteration, ["version"], isolatedIteration)).toString().trim(),
		cliManifest.version,
	);
	assert.match(
		(await run(iterationVault, ["--help"], isolatedIteration)).toString(),
		/Repository and location capture/,
	);
	await compose(primary, "up", "--detach", "--wait");
	assert.equal((await json(primary, "/api/status")).initialized, false);
	const owner = await json(primary, "/api/setup", null, {
		bootstrapToken: primary.bootstrap,
		name: "Rehearsal company",
		email: adminEmail,
		displayName: "Operator",
		password,
	});
	await request(
		primary,
		"/api/setup",
		null,
		{
			bootstrapToken: primary.bootstrap,
			name: "Other",
			email: adminEmail,
			displayName: "Other",
			password,
		},
		"POST",
		409,
	);
	const invitation = await json(
		primary,
		"/api/invitations",
		owner.token,
		{ email: memberEmail, name: "Engineer", role: "member" },
		"POST",
		201,
	);
	const member = await json(primary, "/api/auth/join", null, {
		token: invitation.invitationToken,
		password,
	});
	await json(
		primary,
		"/api/settings/policy",
		owner.token,
		{ repositories: ["https://github.com/example/company-work.git"] },
		"PUT",
	);
	process.stdout.write(
		"PASS fresh install, one-time setup, invitations and company policy\n",
	);

	const home = path.join(scratch, "claude");
	const scope = path.join(scratch, "work");
	const personal = path.join(scratch, "personal");
	const repository = path.join(scratch, "repository");
	await Promise.all([
		mkdir(path.join(home, "projects", "fixture"), { recursive: true }),
		mkdir(scope),
		mkdir(personal),
		mkdir(repository),
	]);
	await run("git", ["init", "--quiet", repository]);
	await run("git", [
		"-C",
		repository,
		"remote",
		"add",
		"origin",
		"https://github.com/example/company-work.git",
	]);
	const sourceSessionId = "11111111-2222-4333-8444-555555555555";
	const record = (cwd, text, uuid) => ({
		type: "user",
		sessionId: sourceSessionId,
		uuid,
		cwd,
		timestamp: "2026-10-01T12:00:00Z",
		message: { role: "user", content: text },
	});
	const filename = path.join(
		home,
		"projects",
		"fixture",
		`${sourceSessionId}.jsonl`,
	);
	const original = `${[
		record(
			scope,
			"approved historical work api_key=companyfixturesecret123456789",
			"work",
		),
		record(personal, "personal must remain local", "personal"),
		record(undefined, "unknown must remain local", "unknown"),
		record(repository, "approved repository work", "repository"),
	]
		.map((value) => JSON.stringify(value))
		.join("\n")}\n`;
	await writeFile(filename, original);
	const directory = path.join(scratch, "collector");
	await interactive(
		cli,
		[
			"connect",
			"claude",
			"--vault",
			primary.origin,
			"--email",
			memberEmail,
			"--location",
			scope,
			"--source-home",
			home,
			"--data-directory",
			directory,
		],
		[
			["Password: ", password],
			["Approve? Type yes: ", "yes"],
		],
	);
	const collect = (executable = cli) =>
		run(
			executable,
			[
				"collect",
				"claude",
				"--vault",
				primary.origin,
				"--data-directory",
				directory,
				"--once",
			],
			{ cwd: scratch },
		);
	await collect();
	const config = JSON.parse(
		await readFile(path.join(directory, "config.json"), "utf8"),
	);
	assert.ok(
		!JSON.stringify(config).includes(password) &&
			!JSON.stringify(config).includes(member.token),
	);
	await request(primary, "/api/sessions", config.token, undefined, "GET", 403);
	await request(primary, "/api/sessions", null, undefined, "GET", 401);
	await request(
		primary,
		"/api/auth/login",
		null,
		{ email: adminEmail, password },
		"POST",
		403,
		{ Origin: "https://attacker.example" },
	);
	const sessions = (await json(primary, "/api/sessions", member.token)).items;
	assert.equal(sessions.length, 1);
	const sessionId = sessions[0].id;
	const exportText = (project = primary) =>
		request(project, `/api/sessions/${sessionId}/export`, member.token).then(
			(response) => response.text(),
		);
	const firstExport = await exportText();
	assert.match(firstExport, /approved historical work/);
	assert.match(firstExport, /approved repository work/);
	assert.ok(
		!/personal must remain local|unknown must remain local|companyfixturesecret123456789/.test(
			firstExport,
		),
	);
	assert.equal(await readFile(filename, "utf8"), original);
	process.stdout.write(
		"PASS installed collector: approved location + repository history, personal exclusion, redaction, unchanged originals, read isolation\n",
	);

	await appendFile(
		filename,
		`${JSON.stringify(record(scope, "new ongoing work", "ongoing"))}\n`,
	);
	await collect(iterationVault);
	const expectedExport = await exportText();
	assert.match(expectedExport, /new ongoing work/);
	await collect();
	assert.equal(await exportText(), expectedExport);
	await compose(primary, "restart", "vault");
	await compose(
		primary,
		"up",
		"--detach",
		"--wait",
		"--no-build",
		"--force-recreate",
		"vault",
	);
	assert.equal(await exportText(), expectedExport);
	const migrationCount = (
		await compose(
			primary,
			"exec",
			"-T",
			"database",
			"psql",
			"-U",
			"trace_vault",
			"-d",
			"trace_vault",
			"-Atc",
			"SELECT count(*) FROM vault_migrations.__drizzle_migrations",
		)
	)
		.toString()
		.trim();
	const migrationJournal = JSON.parse(
		await readFile(
			path.join(workspace, "packages/vault/migrations/meta/_journal.json"),
			"utf8",
		),
	);
	assert.equal(migrationCount, String(migrationJournal.entries.length));
	process.stdout.write(
		`PASS ongoing collection through iteration-cli's trace-vault entrypoint, idempotent retries through standalone collector, restart + current-version replacement (${migrationCount} vault migrations retained)\n`,
	);

	const deletedEvents = expectedExport
		.trim()
		.split("\n")
		.map((line) => {
			const event = JSON.parse(line);
			return {
				...event,
				eventId: `${event.eventId}-deleted`,
				sessionId: "deleted-session",
			};
		});
	await request(
		primary,
		"/api/traces/ingest",
		config.token,
		{ events: deletedEvents },
		"POST",
		202,
	);
	const doomed = (
		await json(primary, "/api/sessions", member.token)
	).items.find((session) => session.id !== sessionId);
	assert.ok(doomed);
	await request(
		primary,
		`/api/sessions/${doomed.id}`,
		member.token,
		undefined,
		"DELETE",
		204,
	);
	const before = await json(primary, "/api/audit", owner.token);
	const backup = await compose(
		primary,
		"exec",
		"-T",
		"database",
		"pg_dump",
		"-U",
		"trace_vault",
		"-d",
		"trace_vault",
		"--format=custom",
		"--no-owner",
		"--no-acl",
	);
	assert.ok(backup.byteLength > 0);
	const restored = await newProject("restored");
	await compose(restored, "up", "--detach", "--wait", "database");
	await run(
		docker[0],
		[
			...docker.slice(1),
			"compose",
			"--project-name",
			restored.name,
			"--env-file",
			restored.env,
			"-f",
			"compose.yaml",
			"exec",
			"-T",
			"database",
			"pg_restore",
			"-U",
			"trace_vault",
			"-d",
			"trace_vault",
			"--exit-on-error",
			"--no-owner",
			"--no-acl",
		],
		{ input: backup, env: composeEnvironment },
	);
	await compose(restored, "up", "--detach", "--wait", "--no-build", "vault");
	assert.equal(await exportText(restored), expectedExport);
	assert.deepEqual(
		await json(restored, "/api/me/capture-rules", member.token),
		await json(primary, "/api/me/capture-rules", member.token),
	);
	assert.deepEqual(await json(restored, "/api/audit", owner.token), before);
	assert.equal(
		(await json(restored, "/api/members", owner.token)).items.length,
		2,
	);
	assert.equal(
		(await json(restored, "/api/collector/policy", config.token)).revision,
		(await json(primary, "/api/collector/policy", config.token)).revision,
	);
	process.stdout.write(
		`PASS backup/restore into separate empty database: ${backup.byteLength} bytes, byte-identical NDJSON, members, scopes, audit and credentials\n`,
	);

	const tombstones = (
		await compose(
			restored,
			"exec",
			"-T",
			"database",
			"psql",
			"-U",
			"trace_vault",
			"-d",
			"trace_vault",
			"-Atc",
			"SELECT count(*) FROM vault_traces.trace_session_deletions",
		)
	)
		.toString()
		.trim();
	assert.equal(tombstones, "1");
	await request(
		restored,
		"/api/traces/ingest",
		config.token,
		{ events: deletedEvents },
		"POST",
		202,
	);
	assert.equal(
		(await json(restored, "/api/sessions", member.token)).items.length,
		1,
	);
	assert.equal(await exportText(restored), expectedExport);
	process.stdout.write(
		"PASS restored deletion tombstones prevent authorized retry from resurrecting evidence\n",
	);
	const newPassword = "synthetic-recovered-admin-password";
	await interactive(
		docker[0],
		[
			...docker.slice(1),
			"compose",
			"--project-name",
			restored.name,
			"--env-file",
			restored.env,
			"-f",
			path.join(workspace, "compose.yaml"),
			"exec",
			"vault",
			"node",
			"dist/operator.js",
			"recover-admin",
			"--email",
			adminEmail,
		],
		[
			["New password (hidden): ", newPassword],
			["Confirm password (hidden): ", newPassword],
		],
	);
	await request(restored, "/api/me", owner.token, undefined, "GET", 401);
	await request(
		restored,
		"/api/auth/login",
		null,
		{ email: adminEmail, password },
		"POST",
		401,
	);
	const recovered = await json(restored, "/api/auth/login", null, {
		email: adminEmail,
		password: newPassword,
	});
	assert.ok(
		(await json(restored, "/api/audit", recovered.token)).items.some(
			(entry) => entry.action === "admin.password_recovered",
		),
	);
	assert.equal(await exportText(restored), expectedExport);
	assert.equal(
		(await json(restored, "/api/me", member.token)).member.email,
		memberEmail,
	);
	process.stdout.write(
		"PASS shipping operator CLI: hidden password confirmation, old login + sessions revoked, new login succeeds, member/history unchanged, audited\n",
	);
	process.stdout.write(
		"REHEARSAL PASSED (Linux, PostgreSQL 17, shipping container and installed collector; not a prior-version upgrade)\n",
	);
} finally {
	let cleanupFailed = false;
	for (const project of projects.reverse()) {
		try {
			await compose(project, "down", "--volumes", "--remove-orphans");
		} catch (error) {
			cleanupFailed = true;
			process.stderr.write(
				`Cleanup failed for disposable project ${project.name}: ${error.message}\n`,
			);
		}
	}
	if (!cleanupFailed) await rm(scratch, { recursive: true, force: true });
	else process.exitCode = 1;
}
