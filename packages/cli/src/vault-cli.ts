#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	COLLECTOR_SOURCES,
	vaultCapturePolicySchema,
} from "iteration-trace-contracts";
import { sourceHome } from "./auto-connect.js";
import { CLAUDE_ACCOUNT_VERSION } from "./claude-account.js";
import { collectorTick } from "./collector.js";
import { acquireCollectorLock } from "./service.js";
import {
	collectorPaths,
	collectorSource,
	loadConfig,
	outboxSize,
	type CollectorConfig,
	type CollectorPaths,
} from "./storage.js";
import { fetchVaultPolicy, vaultOrigin, vaultRequest } from "./vault-api.js";
import {
	defaultVaultDirectory,
	enrollVault,
	vaultMemberLogin,
	type VaultPrompts,
} from "./vault-enrollment.js";
import { resolveCaptureLocation } from "./vault-scope.js";
import {
	approveClaudeAccount,
	setupClaudeAccount,
	startConfiguredClaudeReceiver,
} from "./claude-account-setup.js";

const HELP = `Company vault collector (independent of an Iteration account)

trace-vault connect <codex|claude|cursor> --vault <origin> [--join] [--email <email>] [--location <absolute-root>] [--source-home <directory>]
trace-vault collect <source> --vault <origin> [--once]
trace-vault status <source> --vault <origin>
trace-vault policy <source> --vault <origin>
trace-vault rules <source> --vault <origin> [--email <email>] [--location <absolute-root>] [--clear-locations]
trace-vault account-setup claude --vault <origin> [--port <loopback-port>]
trace-vault approve-account claude --vault <origin> [--email <email>]

All commands accept --data-directory <directory>. Repeat --location to approve multiple roots.
Passwords and invitation tokens are requested privately, never as command-line arguments.
connect approves matching existing history and ongoing collection once. collect stays in the foreground; --once runs one bounded scan/upload tick.
No startup service is installed by this standalone bundle. Stop ongoing collection with Ctrl-C.
Prospective account capture supports terminal Claude Code ${CLAUDE_ACCOUNT_VERSION} only. account-setup explicitly configures metadata-only local OTLP; restart Claude and keep collect running, submit a request, then approve-account selects an actually observed account+organization. Logs contain no enabled prompt/response/tool/body content. The bounded local ledger retains identifiers for 30 days (20,000 records / 8 MiB); every native record must join exact request/message evidence, never a whole session.
Codex and Cursor account capture is unsupported: their native session/account labels are not contemporaneous identity evidence. Repository and location capture remain available for all sources.
Cursor transcripts without per-record workspace evidence require an explicitly selected transcript-storage root; project labels are not proof of repository ownership.
Unmatched originals remain only in their existing agent files; policy changes trigger history reevaluation.
`;

async function question(label: string, hidden = false): Promise<string> {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"Enrollment requires an interactive terminal for private password entry.",
		);
	const muted = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	const reader = createInterface({
		input: process.stdin,
		output: hidden ? muted : process.stdout,
		terminal: true,
	});
	if (hidden) process.stdout.write(label);
	try {
		return await reader.question(hidden ? "" : label);
	} finally {
		reader.close();
		muted.destroy();
		if (hidden) process.stdout.write("\n");
	}
}

const prompts: VaultPrompts = {
	secret: (label) => question(label, true),
	text: (label) => question(label),
	approve: async (description) => {
		process.stdout.write(`${description}\n`);
		return (
			(await question("Approve? Type yes: ")).trim().toLowerCase() === "yes"
		);
	},
};

function cliArguments() {
	return parseArgs({
		allowPositionals: true,
		options: {
			vault: { type: "string" },
			email: { type: "string" },
			join: { type: "boolean" },
			location: { type: "string", multiple: true },
			"clear-locations": { type: "boolean" },
			"source-home": { type: "string" },
			"data-directory": { type: "string" },
			port: { type: "string" },
			once: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
}

type CliValues = ReturnType<typeof cliArguments>["values"];

function validateCommandOptions(command: string, values: CliValues): void {
	if (values.port && command !== "account-setup")
		throw new Error("--port applies only to account-setup.");
	if ((values.join || values["source-home"]) && command !== "connect")
		throw new Error("--join and --source-home apply only to connect.");
	if (
		(values.location || values["clear-locations"]) &&
		!["connect", "rules"].includes(command)
	)
		throw new Error(
			"Location changes require connect or rules and explicit approval.",
		);
}

function readCommand() {
	const { positionals, values } = cliArguments();
	const [command, rawSource] = positionals;
	if (values.help || command === undefined || command === "help") {
		process.stdout.write(HELP);
		return null;
	}
	const source = COLLECTOR_SOURCES.find((candidate) => candidate === rawSource);
	if (!source || positionals.length !== 2)
		throw new Error(
			"Specify exactly one source: codex, claude, or cursor. Run trace-vault --help.",
		);
	if (
		["approve-account", "account-setup"].includes(command) &&
		source !== "claude"
	)
		throw new Error(
			`Secure account-based capture is unsupported for ${source}: contemporaneous request-level evidence is unavailable in this build. Use repository or location scopes.`,
		);
	if (
		![
			"connect",
			"collect",
			"status",
			"policy",
			"rules",
			"account-setup",
			"approve-account",
		].includes(command)
	)
		throw new Error("Unknown command. Run trace-vault --help.");
	validateCommandOptions(command, values);
	const origin = values.vault ? vaultOrigin(values.vault) : undefined;
	const directory = values["data-directory"]
		? path.resolve(values["data-directory"])
		: origin
			? defaultVaultDirectory(origin, source)
			: undefined;
	if (!directory)
		throw new Error(
			"Specify --vault <origin> or --data-directory <directory>.",
		);
	return { command, source, values, origin, directory };
}

async function main(): Promise<void> {
	const args = readCommand();
	if (args === null) return;
	const { command, source, values, origin, directory } = args;
	const paths = collectorPaths(directory);
	if (command === "connect") {
		await connectVault(args);
		return;
	}
	const config = await loadConfig(paths);
	if (config.destination !== "vault" || collectorSource(config) !== source)
		throw new Error(
			"This directory is not an enrolled company vault collector for the selected source.",
		);
	const configuredOrigin = new URL(config.endpoint).origin;
	if (origin && origin !== configuredOrigin)
		throw new Error("--vault does not match this collector's company vault.");
	if (await accountCommand(command, config, values)) return;
	if (command === "rules") {
		const token = await vaultMemberLogin(
			configuredOrigin,
			prompts,
			false,
			values.email,
		);
		const current = vaultCapturePolicySchema.parse(
			await vaultRequest(
				configuredOrigin,
				"/api/me/capture-rules",
				token,
				"GET",
			),
		);
		const locations = [
			...new Set([
				...(values["clear-locations"] ? [] : current.locations),
				...(values.location ?? []).map(resolveCaptureLocation),
			]),
		];
		if (!values.location && !values["clear-locations"]) {
			process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
			return;
		}
		if (
			!(await prompts.approve(
				`Approve company vault local roots (including matching existing history):\n${locations.join("\n") || "none"}`,
			))
		)
			throw new Error("Capture rule changes cancelled.");
		const updated = vaultCapturePolicySchema.parse(
			await vaultRequest(
				configuredOrigin,
				"/api/me/capture-rules",
				token,
				"PUT",
				{ accounts: current.accounts, locations },
			),
		);
		process.stdout.write(
			`Company vault capture rules updated to revision ${updated.revision}.\n`,
		);
		return;
	}
	if (command === "status" || command === "policy") {
		const policy = await fetchVaultPolicy(config.endpoint, config.token);
		process.stdout.write(
			`${JSON.stringify({ vault: configuredOrigin, source, outboxBytes: await outboxSize(paths), policy, accountCapture: source === "claude" ? `request-level metadata; terminal Claude Code ${CLAUDE_ACCOUNT_VERSION}; explicit setup required` : "unsupported", collection: "foreground only" }, null, 2)}\n`,
		);
		return;
	}
	await runCollection(config, paths, values.once ?? false);
}

async function connectVault(
	args: NonNullable<ReturnType<typeof readCommand>>,
): Promise<void> {
	const { source, values, origin, directory } = args;
	if (!origin) throw new Error("connect requires --vault <origin>.");
	if (values["clear-locations"])
		throw new Error(
			"Use rules --clear-locations to remove approved locations.",
		);
	const release = await acquireCollectorLock(collectorPaths(directory));
	try {
		await enrollVault(
			{
				origin,
				source,
				home: values["source-home"] ?? sourceHome(source),
				directory,
				join: values.join ?? false,
				email: values.email,
				locations: values.location ?? [],
			},
			prompts,
		);
	} finally {
		await release();
	}
	process.stdout.write(
		`Company vault enrolled. No startup service installed. Run trace-vault collect ${source} --data-directory ${JSON.stringify(directory)} to collect in the foreground.\n`,
	);
}

async function runCollection(
	config: CollectorConfig,
	paths: CollectorPaths,
	once: boolean,
): Promise<void> {
	const source = collectorSource(config);
	const release = await acquireCollectorLock(paths);
	const abort = new AbortController();
	const stop = () => abort.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	let receiver: Awaited<ReturnType<typeof startConfiguredClaudeReceiver>> =
		null;
	try {
		receiver = await startConfiguredClaudeReceiver(config);
		if (receiver !== null)
			process.stdout.write(
				`Claude metadata-only receiver active (terminal Claude Code ${CLAUDE_ACCOUNT_VERSION}).\n`,
			);
		do {
			let waitMs = 5000;
			try {
				const result = await collectorTick(
					config,
					paths,
					undefined,
					abort.signal,
				);
				process.stdout.write(`${JSON.stringify({ source, ...result })}\n`);
				waitMs = Math.max(waitMs, result.retryAfterMs);
			} catch (error) {
				if (abort.signal.aborted) break;
				if (once) throw error;
				process.stderr.write(
					`${error instanceof Error ? error.message : "Company vault collection failed."}\n`,
				);
				waitMs = 30_000;
			}
			if (once) break;
			await delay(waitMs, undefined, { signal: abort.signal }).catch(
				(error: unknown) => {
					if (!abort.signal.aborted) throw error;
				},
			);
		} while (!abort.signal.aborted);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		try {
			await receiver?.close();
		} finally {
			await release();
		}
	}
}

async function accountCommand(
	command: string,
	config: CollectorConfig,
	values: CliValues,
): Promise<boolean> {
	if (command === "approve-account") {
		await approveClaudeAccount(config, prompts, values.email);
		process.stdout.write(
			"Exact observed Claude account and organization approved for the company vault.\n",
		);
		return true;
	}
	if (command !== "account-setup") return false;
	const release = await acquireCollectorLock(
		collectorPaths(config.dataDirectory),
	);
	try {
		await setupClaudeAccount(
			config,
			prompts,
			values.port ? Number(values.port) : 4319,
		);
	} finally {
		await release();
	}
	process.stdout.write(
		`Claude metadata-only setup saved. Restart Claude Code ${CLAUDE_ACCOUNT_VERSION} and run collect claude; then use approve-account claude after a request completes.\n`,
	);
	return true;
}

main().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Company vault command failed."}\n`,
	);
	process.exitCode = 1;
});
