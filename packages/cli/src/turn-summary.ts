import { ensurePrivateDirectory } from "./private-storage.js";
import { windowsHookInvocation } from "./windows-powershell.js";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import {
	type CollectorFrictionSummary,
	isLaunchDirectory,
	parseCollectorFrictionSummary,
} from "iteration-trace-contracts";
import * as z from "zod";
import { type CollectorFetcher, collectorFetch } from "./collector-fetch.js";
import { claudeGitHookPaths } from "./claude-git-hook.js";
import { runtimePaths, stableNodePath } from "./runtime.js";
import { type CollectorConfig } from "./storage.js";

const execFile = promisify(execFileCallback);

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REFRESHES_PER_PASS = 20;
const REQUEST_TIMEOUT_MS = 10_000;
const HOOK_TIMEOUT_SECONDS = 1;
const REQUEST_KEY_PATTERN = /^\d{1,10}$/;

export type TurnSummaryPaths = Readonly<{
	directory: string;
	script: string;
	requests: string;
	lines: string;
	shown: string;
}>;

export function turnSummaryPaths(dataDirectory: string): TurnSummaryPaths {
	const directory = path.join(dataDirectory, "turn-summary");
	return {
		directory,
		script: path.join(directory, "stop-hook.sh"),
		requests: path.join(directory, "requests"),
		lines: path.join(directory, "lines"),
		shown: path.join(directory, "shown"),
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// The hook runs at the end of every agent turn, so it only reads files the
// collector keeps current and never waits on the network. Every failure prints
// the empty object both agents accept, so a broken summary never blocks a turn.
function hookScript(paths: TurnSummaryPaths): string {
	return `#!/bin/sh
exec 2>/dev/null
cat >/dev/null
summary=${shellQuote(paths.directory)}
quiet() { printf '{}\\n'; exit 0; }
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_PREFIX
cd "\${CLAUDE_PROJECT_DIR:-.}" || quiet
directory=$(git rev-parse --show-toplevel) || quiet
case $directory in /*) ;; *) quiet ;; esac
set -- $(printf '%s' "$directory" | cksum)
key=$1
[ -n "$key" ] || quiet
printf '%s\\n' "$directory" > "$summary/requests/$key"
[ -f "$summary/lines/$key" ] || quiet
{ IFS= read -r owner && IFS= read -r message; } < "$summary/lines/$key" || quiet
[ "$owner" = "$directory" ] || quiet
last=
[ -f "$summary/shown/$key" ] && IFS= read -r last < "$summary/shown/$key"
[ "$last" = "$message" ] && quiet
printf '%s\\n' "$message" > "$summary/shown/$key" || quiet
printf '%s\\n' "$message"
`;
}

type CommandInvocation =
	| Readonly<{ command: string; args: readonly string[] }>
	| Readonly<{ command: string; args?: never }>;

function stopHookTimeout(config: CollectorConfig): number {
	return process.platform === "win32" && "codexHome" in config
		? 3
		: HOOK_TIMEOUT_SECONDS;
}

async function windowsHookCommand(
	config: CollectorConfig,
	operation: string,
): Promise<CommandInvocation> {
	const node = await stableNodePath();
	const args = [runtimePaths().launcher, operation, config.dataDirectory];
	if ("claudeHome" in config) return { command: node, args };
	return { command: windowsHookInvocation(node, args) };
}

async function stopHookCommand(
	config: CollectorConfig,
): Promise<CommandInvocation> {
	if (process.platform === "win32")
		return windowsHookCommand(config, "turn-summary-hook");
	return {
		command: `/bin/sh ${shellQuote(turnSummaryPaths(config.dataDirectory).script)}`,
	};
}

async function sessionStartCommand(
	config: CollectorConfig,
): Promise<CommandInvocation> {
	if (process.platform === "win32")
		return windowsHookCommand(config, "claude-git-hook");
	return {
		command: `/bin/sh ${shellQuote(claudeGitHookPaths(config.dataDirectory).script)}`,
	};
}

function agentHookFile(config: CollectorConfig): string {
	if ("cursorHome" in config)
		throw new Error("Cursor uses its own trace hooks.");
	return "claudeHome" in config
		? path.join(config.claudeHome, "settings.json")
		: path.join(config.codexHome, "hooks.json");
}

const hookEntrySchema = z
	.object({
		command: z.string().optional(),
		args: z.array(z.string()).readonly().optional(),
	})
	.loose();
const hookGroupSchema = z
	.object({ hooks: z.array(hookEntrySchema).optional() })
	.loose();
const hookFileSchema = z
	.object({
		hooks: z
			.object({
				Stop: z.array(hookGroupSchema).optional(),
				SessionStart: z.array(hookGroupSchema).optional(),
			})
			.loose()
			.optional(),
	})
	.loose();

type HookFile = z.infer<typeof hookFileSchema>;

async function readHookFile(
	filename: string,
): Promise<Readonly<{ file: HookFile; mode: number }>> {
	let contents: string;
	let mode = 0o600;
	try {
		contents = await fs.readFile(filename, "utf8");
		mode = (await fs.stat(filename)).mode & 0o777;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { file: {}, mode };
		}
		throw new Error(`Could not read agent hooks at ${filename}.`, {
			cause: error,
		});
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Agent hooks at ${filename} are not valid JSON.`, {
			cause: error,
		});
	}
	const parsed = hookFileSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new Error(`Agent hooks at ${filename} have an unexpected shape.`, {
			cause: parsed.error,
		});
	}
	return { file: parsed.data, mode };
}

async function writeHookFile(
	filename: string,
	file: HookFile,
	mode: number,
): Promise<void> {
	await fs.mkdir(path.dirname(filename), { recursive: true });
	// Settings kept in a dotfiles repository are often symlinks; replacing the
	// link with a file would silently detach them from that repository.
	const target = await fs.realpath(filename).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return filename;
		throw error;
	});
	const temporary = `${target}.iteration-${process.pid}.tmp`;
	await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
		encoding: "utf8",
		mode,
	});
	await fs.rename(temporary, target);
}

type HookGroup = z.infer<typeof hookGroupSchema>;

function withoutCommand(
	groups: readonly HookGroup[],
	command: CommandInvocation,
): HookGroup[] {
	return groups.flatMap((group) => {
		const hooks = group.hooks?.filter((hook) => !sameCommand(hook, command));
		if (hooks === undefined || hooks.length === group.hooks?.length)
			return [group];
		return hooks.length === 0 ? [] : [{ ...group, hooks }];
	});
}

function sameCommand(
	hook: z.infer<typeof hookEntrySchema>,
	invocation: CommandInvocation,
): boolean {
	return (
		hook.command === invocation.command &&
		(invocation.args === undefined
			? hook.args === undefined
			: hook.args?.length === invocation.args.length &&
				invocation.args.every((arg, index) => hook.args?.[index] === arg))
	);
}

function hasCommand(
	groups: readonly HookGroup[],
	command: CommandInvocation,
): boolean {
	return groups.some((group) =>
		group.hooks?.some((hook) => sameCommand(hook, command)),
	);
}

export async function installTurnSummary(
	config: CollectorConfig,
): Promise<void> {
	const paths = turnSummaryPaths(config.dataDirectory);
	await ensurePrivateDirectory(paths.directory);
	await Promise.all(
		[paths.requests, paths.lines, paths.shown].map(ensurePrivateDirectory),
	);
	if (process.platform !== "win32") {
		await fs.writeFile(paths.script, hookScript(paths), {
			encoding: "utf8",
			mode: 0o700,
		});
		await fs.chmod(paths.script, 0o700);
	}
	if ("claudeHome" in config) {
		const gitPaths = claudeGitHookPaths(config.dataDirectory);
		await ensurePrivateDirectory(gitPaths.queue);
		if (process.platform !== "win32") {
			await fs.writeFile(
				gitPaths.script,
				`#!/bin/sh\nexec ${shellQuote(await stableNodePath())} ${shellQuote(runtimePaths().launcher)} claude-git-hook ${shellQuote(config.dataDirectory)}\n`,
				{ encoding: "utf8", mode: 0o700 },
			);
			await fs.chmod(gitPaths.script, 0o700);
		}
	}
	const filename = agentHookFile(config);
	const { file, mode } = await readHookFile(filename);
	const command = await stopHookCommand(config);
	const startCommand = await sessionStartCommand(config);
	const stop = file.hooks?.Stop ?? [];
	const start = file.hooks?.SessionStart ?? [];
	if (
		hasCommand(stop, command) &&
		(!("claudeHome" in config) || hasCommand(start, startCommand))
	)
		return;
	await writeHookFile(
		filename,
		{
			...file,
			hooks: {
				...file.hooks,
				Stop: hasCommand(stop, command)
					? stop
					: [
							...stop,
							{
								hooks: [
									{
										type: "command",
										...command,
										timeout: stopHookTimeout(config),
									},
								],
							},
						],
				...("claudeHome" in config
					? {
							SessionStart: hasCommand(start, startCommand)
								? start
								: [
										...start,
										{
											hooks: [{ type: "command", ...startCommand, timeout: 3 }],
										},
									],
						}
					: {}),
			},
		},
		mode,
	);
}

export async function uninstallTurnSummary(
	config: CollectorConfig,
): Promise<void> {
	const filename = agentHookFile(config);
	const { file, mode } = await readHookFile(filename);
	const stop = file.hooks?.Stop ?? [];
	const command = await stopHookCommand(config);
	const start = file.hooks?.SessionStart ?? [];
	const startCommand = await sessionStartCommand(config);
	if (!hasCommand(stop, command) && !hasCommand(start, startCommand)) return;
	const remaining = withoutCommand(stop, command);
	const remainingStart = withoutCommand(start, startCommand);
	const {
		Stop: _removed,
		SessionStart: _removedStart,
		...otherEvents
	} = file.hooks ?? {};
	await writeHookFile(
		filename,
		{
			...file,
			hooks: {
				...otherEvents,
				...(remaining.length > 0 ? { Stop: remaining } : {}),
				...(remainingStart.length > 0 ? { SessionStart: remainingStart } : {}),
			},
		},
		mode,
	);
}

// The turn-summary-hook command on Windows; it does what stop-hook.sh does on
// POSIX systems. Every failure prints the empty object both agents accept, so
// a broken summary never blocks a turn.
export async function captureTurnSummary(dataDirectory: string): Promise<void> {
	const quiet = () => process.stdout.write("{}\n");
	for await (const chunk of process.stdin) void chunk;
	const gitEnv = { ...process.env };
	delete gitEnv.GIT_DIR;
	delete gitEnv.GIT_WORK_TREE;
	delete gitEnv.GIT_COMMON_DIR;
	delete gitEnv.GIT_PREFIX;
	let directory: string;
	try {
		({ stdout: directory } = await execFile(
			"git",
			["rev-parse", "--show-toplevel"],
			{
				cwd: process.env.CLAUDE_PROJECT_DIR ?? ".",
				env: gitEnv,
				timeout: 5_000,
				windowsHide: true,
			},
		));
		// Git reports forward slashes on Windows; key the repository by its
		// native path like the POSIX script does.
		directory = path.normalize(directory.trim());
	} catch {
		quiet();
		return;
	}
	if (!path.isAbsolute(directory)) {
		quiet();
		return;
	}
	const key = String(crc32(directory));
	const paths = turnSummaryPaths(dataDirectory);
	try {
		await fs.writeFile(path.join(paths.requests, key), `${directory}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		// The request is a hint for the collector; a failed write still reads.
	}
	let lines: string;
	try {
		lines = await fs.readFile(path.join(paths.lines, key), "utf8");
	} catch {
		quiet();
		return;
	}
	const [owner, message] = lines.split("\n");
	if (owner !== directory || message === undefined || message === "") {
		quiet();
		return;
	}
	let last: string | null;
	try {
		last =
			(await fs.readFile(path.join(paths.shown, key), "utf8")).split("\n")[0] ??
			null;
	} catch {
		last = null;
	}
	if (last === message) {
		quiet();
		return;
	}
	try {
		await fs.writeFile(path.join(paths.shown, key), `${message}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		quiet();
		return;
	}
	process.stdout.write(`${message}\n`);
}

export function turnSummaryMessage(
	summary: CollectorFrictionSummary,
): string | null {
	if (summary.weekEpisodes === 0) return null;
	const episodes = `${summary.weekEpisodes} friction episode${summary.weekEpisodes === 1 ? "" : "s"}`;
	const recent =
		summary.dayEpisodes === 0
			? ""
			: ` · ${summary.dayEpisodes} new since yesterday`;
	return `◆ Iteration · ${episodes} in this repo this week${recent}`;
}

export class TurnSummaryRefreshError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TurnSummaryRefreshError";
	}
}

async function fetchSummary(
	config: CollectorConfig,
	directory: string,
	fetcher: CollectorFetcher,
	signal: AbortSignal | undefined,
): Promise<CollectorFrictionSummary> {
	const url = new URL("/api/traces/friction-summary", config.endpoint);
	url.searchParams.set("directory", directory);
	let response: Response;
	try {
		response = await fetcher(url, {
			headers: { authorization: `Bearer ${config.token}` },
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
				: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new TurnSummaryRefreshError(
			"Friction summary could not reach Iteration.",
			{ cause: error },
		);
	}
	if (response.status !== 200) {
		throw new TurnSummaryRefreshError(
			`Friction summary failed with HTTP ${response.status}.`,
		);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		throw new TurnSummaryRefreshError(
			"Friction summary returned an unreadable response.",
			{ cause: error },
		);
	}
	const parsed = parseCollectorFrictionSummary(body);
	if (!parsed.success) throw new TurnSummaryRefreshError(parsed.error);
	return parsed.value;
}

async function readRequest(filename: string): Promise<string | null> {
	try {
		const [directory] = (await fs.readFile(filename, "utf8")).split("\n");
		return directory ?? null;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

async function writeLine(
	paths: TurnSummaryPaths,
	key: string,
	directory: string,
	message: string | null,
): Promise<void> {
	const filename = path.join(paths.lines, key);
	if (message === null) {
		await fs.rm(filename, { force: true });
		return;
	}
	const temporary = `${filename}.${process.pid}.tmp`;
	await fs.writeFile(
		temporary,
		`${directory}\n${JSON.stringify({ systemMessage: message })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await fs.rename(temporary, filename);
}

async function forget(paths: TurnSummaryPaths, key: string): Promise<void> {
	await Promise.all(
		[paths.requests, paths.lines, paths.shown].map((directory) =>
			fs.rm(path.join(directory, key), { force: true }),
		),
	);
}

// Refreshes the summary line for each repository the hook asked about. The
// hook reads the result on a later turn, so a slow or failed request never
// delays the agent.
export async function refreshTurnSummaries(
	config: CollectorConfig,
	refreshedAt: Map<string, Readonly<{ directory: string; atMs: number }>>,
	nowMs: number,
	fetcher: CollectorFetcher = collectorFetch,
	signal?: AbortSignal,
): Promise<number> {
	const paths = turnSummaryPaths(config.dataDirectory);
	let keys: string[];
	try {
		keys = await fs.readdir(paths.requests);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return 0;
		throw error;
	}
	let refreshed = 0;
	for (const key of keys.sort()) {
		signal?.throwIfAborted();
		if (!REQUEST_KEY_PATTERN.test(key)) continue;
		const filename = path.join(paths.requests, key);
		const stats = await fs.stat(filename).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return null;
			throw error;
		});
		if (stats === null) continue;
		const directory = await readRequest(filename);
		if (
			nowMs - stats.mtimeMs > REQUEST_RETENTION_MS ||
			directory === null ||
			!isLaunchDirectory(directory)
		) {
			await forget(paths, key);
			refreshedAt.delete(key);
			continue;
		}
		const previous = refreshedAt.get(key);
		if (
			previous !== undefined &&
			previous.directory === directory &&
			nowMs - previous.atMs < REFRESH_INTERVAL_MS
		) {
			continue;
		}
		if (refreshed === MAX_REFRESHES_PER_PASS) break;
		refreshedAt.set(key, { directory, atMs: nowMs });
		refreshed += 1;
		const summary = await fetchSummary(config, directory, fetcher, signal);
		await writeLine(paths, key, directory, turnSummaryMessage(summary));
	}
	return refreshed;
}

export type TurnSummaryApproval =
	| "approved"
	| "needs_approval"
	| "not_installed";

function tomlBasicString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Codex runs a hook only after the developer trusts it in /hooks, and records
// that trust as a hash of the normalized hook. Recomputing the same hash tells
// whether Codex will run this exact entry; any other result keeps the reminder.
function codexHookHash(command: string, timeout: number): string {
	const identity = {
		event_name: "stop",
		hooks: [
			{
				async: false,
				command,
				timeout,
				type: "command",
			},
		],
	};
	return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function codexTrustedHash(configToml: string, key: string): string | null {
	const lines = configToml.split(/\r?\n/);
	const header = `[hooks.state.${tomlBasicString(key)}]`;
	const start = lines.findIndex((line) => line.trim() === header);
	if (start < 0) return null;
	let trustedHash: string | null = null;
	for (const line of lines.slice(start + 1)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) break;
		if (/^enabled\s*=\s*false\b/.test(trimmed)) return null;
		const match = /^trusted_hash\s*=\s*"(sha256:[0-9a-f]{64})"/.exec(trimmed);
		if (match?.[1] !== undefined) trustedHash = match[1];
	}
	return trustedHash;
}

export async function codexTurnSummaryApproval(
	config: CollectorConfig,
): Promise<TurnSummaryApproval> {
	if ("claudeHome" in config || "cursorHome" in config) return "approved";
	const filename = agentHookFile(config);
	const { file } = await readHookFile(filename);
	const command = await stopHookCommand(config);
	const stop = file.hooks?.Stop ?? [];
	for (const [groupIndex, group] of stop.entries()) {
		const handlerIndex =
			group.hooks?.findIndex((hook) => sameCommand(hook, command)) ?? -1;
		if (handlerIndex < 0) continue;
		let configToml: string;
		try {
			configToml = await fs.readFile(
				path.join(config.codexHome, "config.toml"),
				"utf8",
			);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return "needs_approval";
			throw new Error("Could not read the Codex config.", { cause: error });
		}
		const trusted = codexTrustedHash(
			configToml,
			`${filename}:stop:${groupIndex}:${handlerIndex}`,
		);
		return trusted === codexHookHash(command.command, stopHookTimeout(config))
			? "approved"
			: "needs_approval";
	}
	return "not_installed";
}
