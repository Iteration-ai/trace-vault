import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod";
import {
	CLAUDE_ACCOUNT_VERSION,
	ClaudeAccountIndex,
	loadClaudeAccountLedger,
} from "./claude-account.js";
import { startClaudeAccountReceiver } from "./claude-account-receiver.js";
import { ensurePrivateDirectory } from "./private-storage.js";
import type { CollectorConfig } from "./storage.js";
import { vaultRequest } from "./vault-api.js";
import { vaultMemberLogin, type VaultPrompts } from "./vault-enrollment.js";
import {
	vaultAccountReference,
	vaultCapturePolicySchema,
} from "iteration-trace-contracts";

const receiverConfigSchema = z
	.object({
		version: z.literal(1),
		port: z.number().int().min(1024).max(65535),
		secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	})
	.strict();
type ReceiverConfig = z.infer<typeof receiverConfigSchema>;

async function readReceiverConfig(
	directory: string,
): Promise<ReceiverConfig | null> {
	try {
		return receiverConfigSchema.parse(
			JSON.parse(
				await fs.readFile(
					path.join(directory, "claude-account-receiver.json"),
					"utf8",
				),
			),
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw new Error("Claude metadata receiver configuration is invalid.");
	}
}

async function writePrivateJson(
	filename: string,
	value: unknown,
): Promise<void> {
	await ensurePrivateDirectory(path.dirname(filename));
	const temporary = `${filename}.${process.pid}.tmp`;
	try {
		const handle = await fs.open(temporary, "w", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, filename);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

const settingsSchema = z
	.object({ env: z.record(z.string(), z.string()).optional() })
	.catchall(z.json());

async function readSettings(filename: string) {
	try {
		return settingsSchema.parse(
			JSON.parse(await fs.readFile(filename, "utf8")),
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return {};
		throw new Error(
			"Claude user settings are invalid; no telemetry settings were changed.",
		);
	}
}

function metadataEnvironment(config: ReceiverConfig): Record<string, string> {
	return {
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
		OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${config.port}/v1/logs/${config.secret}`,
		OTEL_METRICS_EXPORTER: "none",
		OTEL_TRACES_EXPORTER: "none",
		OTEL_LOG_USER_PROMPTS: "0",
		OTEL_LOG_ASSISTANT_RESPONSES: "0",
		OTEL_LOG_TOOL_DETAILS: "0",
		OTEL_LOG_TOOL_CONTENT: "0",
		OTEL_LOG_RAW_API_BODIES: "0",
		CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "0",
		ENABLE_ENHANCED_TELEMETRY_BETA: "0",
		ENABLE_BETA_TRACING_DETAILED: "0",
		OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "true",
		OTEL_METRICS_INCLUDE_SESSION_ID: "true",
	};
}

function checkExporterConflicts(
	existing: Readonly<Record<string, string | undefined>>,
	desired: Readonly<Record<string, string>>,
): void {
	for (const [key, value] of Object.entries(existing)) {
		if (value === undefined || value === "") continue;
		if (
			!(
				key.startsWith("OTEL_") ||
				key.includes("TELEMETRY") ||
				key === "BETA_TRACING_ENDPOINT" ||
				key === "ENABLE_BETA_TRACING_DETAILED"
			)
		)
			continue;
		if (desired[key] !== value)
			throw new Error(
				`Existing ${key} conflicts with metadata-only local collection. Keep your exporter unchanged or remove that setting explicitly before setup.`,
			);
	}
}

export async function setupClaudeAccount(
	config: CollectorConfig,
	prompts: VaultPrompts,
	port = 4319,
): Promise<void> {
	if (!("claudeHome" in config) || config.destination !== "vault")
		throw new Error(
			"Request-level account setup is supported only for an enrolled Claude company vault collector.",
		);
	const existing = await readReceiverConfig(config.dataDirectory);
	const receiver =
		existing ??
		receiverConfigSchema.parse({
			version: 1,
			port,
			secret: randomBytes(32).toString("base64url"),
		});
	if (existing && existing.port !== port)
		throw new Error(
			"A Claude metadata receiver is already configured on a different port.",
		);
	const filename = path.join(config.claudeHome, "settings.json");
	const settings = await readSettings(filename);
	const desired = metadataEnvironment(receiver);
	checkExporterConflicts(settings.env ?? {}, desired);
	checkExporterConflicts(process.env, desired);
	if (
		!(await prompts.approve(
			`Enable local request-level account evidence for terminal Claude Code ${CLAUDE_ACCOUNT_VERSION}?\nThis edits ${filename}, exports logs only to a private loopback receiver, disables prompt/response/tool/body telemetry, and preserves unrelated settings. Existing exporter conflicts are refused.\nOnly metadata identifiers are retained (30 days, at most 20,000 records / 8 MiB). Native session originals are not copied. Historical account identity is never inferred.\nRestart Claude and trace-vault collect after setup; other Claude versions fail closed.`,
		))
	)
		throw new Error("Claude metadata setup cancelled.");
	await writePrivateJson(
		path.join(config.dataDirectory, "claude-account-receiver.json"),
		receiver,
	);
	await writePrivateJson(filename, {
		...settings,
		env: { ...settings.env, ...desired },
	});
}

export async function startConfiguredClaudeReceiver(
	config: CollectorConfig,
): Promise<Readonly<{ close: () => Promise<void> }> | null> {
	if (!("claudeHome" in config)) return null;
	const receiver = await readReceiverConfig(config.dataDirectory);
	return receiver === null
		? null
		: startClaudeAccountReceiver(
				config.dataDirectory,
				receiver.port,
				receiver.secret,
			);
}

export async function approveClaudeAccount(
	config: CollectorConfig,
	prompts: VaultPrompts,
	email?: string,
): Promise<void> {
	if (!("claudeHome" in config))
		throw new Error(
			"Secure account capture is unsupported for this source; only Claude has request-level evidence support.",
		);
	const index = new ClaudeAccountIndex(
		await loadClaudeAccountLedger(config.dataDirectory),
	);
	if (index.accounts.length === 0)
		throw new Error(
			`No request-level Claude account identity observed. Run account-setup claude, keep collect claude running, restart Claude Code ${CLAUDE_ACCOUNT_VERSION}, and submit a request before approving an account.`,
		);
	const selection = await prompts.text(
		`Select an observed request-level account and organization:\n${index.accounts.map((account, offset) => `${offset + 1}. account ${account.accountId}, organization ${account.organizationId ?? "none"}`).join("\n")}\nNumber: `,
	);
	const account = index.accounts[Number(selection) - 1];
	if (!account || !/^\d+$/.test(selection))
		throw new Error("Select a listed request-level account.");
	if (
		!(await prompts.approve(
			`Approve company vault capture for exact Claude account ${account.accountId} and organization ${account.organizationId ?? "none"}, including outside repositories? Only individually evidenced native messages/requests qualify; historical session labels do not.`,
		))
	)
		throw new Error("Account capture approval cancelled.");
	const origin = new URL(config.endpoint).origin;
	const token = await vaultMemberLogin(origin, prompts, false, email);
	const current = vaultCapturePolicySchema.parse(
		await vaultRequest(origin, "/api/me/capture-rules", token, "GET"),
	);
	const accounts = current.accounts.filter(
		(entry) => vaultAccountReference(entry) !== vaultAccountReference(account),
	);
	accounts.push(account);
	vaultCapturePolicySchema.parse(
		await vaultRequest(origin, "/api/me/capture-rules", token, "PUT", {
			accounts,
			locations: current.locations,
		}),
	);
}
