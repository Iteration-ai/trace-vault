#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import * as z from "zod";
import {
	COLLECTOR_SOURCES,
	collectorSourceLabel,
	type CollectorSource,
} from "iteration-trace-contracts";
import { authenticateAndEnrollCollector } from "./clerk-device-auth.js";
import {
	activateSource,
	connectedConfig,
	detectedSources,
	expandSource,
	loadMachineConsent,
	readCollectorScope,
	saveMachineConsent,
	sourceHome,
	type MachineConsent,
} from "./auto-connect.js";
import { importSourceHistory } from "./history-import.js";
import {
	cursorHookFailureAtMs,
	installCursorHooks,
	uninstallCursorHooks,
} from "./cursor-hooks.js";
import { runCollector } from "./service.js";
import {
	renderDetailedStatus,
	renderHome,
	renderRuntime,
	safeWorkspaceName,
	type CliStatus,
} from "./status-view.js";
import {
	captureClaudeGit,
	claudeGitHookFailureAtMs,
	recordClaudeGitHookFailure,
} from "./claude-git-hook.js";
import {
	captureTurnSummary,
	installTurnSummary,
	codexTurnSummaryApproval,
	uninstallTurnSummary,
} from "./turn-summary.js";
import { superviseCollector } from "./windows-supervisor.js";
import {
	backgroundServiceStatus,
	collectorLogPath,
	installBackgroundService,
	installedServiceSources,
	isCollectorPlatform,
	prepareBackgroundPersistence,
	requireCollectorPlatform,
	uninstallBackgroundService,
} from "./background-service.js";
import {
	assertFreshCollectorDirectory,
	collectorSource,
	collectorSourceDirectory,
	collectorPaths,
	defaultCollectorDirectory,
	countSavedSessions,
	ensureStartableState,
	healthSnapshot,
	historyScanProgress,
	loadConfig,
	loadState,
	outboxSize,
	pendingEventIds,
	prepareSourceInitialState,
	saveConfig,
	saveState,
	validateCollectorEndpoint,
	type CollectorConfig,
} from "./storage.js";
import {
	compareVersions,
	readRuntimeSettings,
	readRuntimeState,
	runtimePaths,
	versionEntry,
	writeRuntimeSettings,
} from "./runtime.js";
import { ownVersion } from "./runtime-install.js";
import { adoptRuntime, refreshBackgroundServices } from "./runtime-services.js";
import { updateRuntime, validateRegistryUrl } from "./updater.js";

const DEFAULT_INGEST_ENDPOINT = "https://useiteration.com/api/traces/ingest";

function argumentsForCli(): Readonly<{
	command: string;
	source: string | undefined;
	values: Readonly<Record<string, string | boolean | undefined>>;
}> {
	const parsed = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		strict: true,
		options: {
			help: { type: "boolean" },
			endpoint: { type: "string" },
			"device-name": { type: "string" },
			workspace: { type: "string" },
			"codex-home": { type: "string" },
			"claude-home": { type: "string" },
			"cursor-home": { type: "string" },
			"data-directory": { type: "string" },
			registry: { type: "string" },
			"include-history": { type: "boolean" },
			yes: { type: "boolean" },
		},
	});
	if (parsed.positionals.length > 2) {
		throw new Error(
			"Too many command arguments. Run iteration help for usage.",
		);
	}
	return {
		command: parsed.positionals[0] ?? "",
		source: parsed.positionals[1],
		values: parsed.values,
	};
}

function optionalString(
	values: Readonly<Record<string, string | boolean | undefined>>,
	name: string,
): string | null {
	const value = values[name];
	if (value === undefined) return null;
	const parsed = z.string().min(1).safeParse(value);
	if (!parsed.success) {
		throw new Error(`--${name} must be a non-empty string.`);
	}
	return parsed.data;
}

function usage(command?: string): void {
	if (command === "connect") {
		process.stdout.write(
			[
				"Connect a coding agent to Iteration",
				"  iteration connect         Connect all detected agents on this computer",
				"  iteration connect codex",
				"  iteration connect claude",
				"  iteration connect cursor",
				"",
				"Existing local sessions and new activity are collected automatically.",
				"",
				"Options for advanced setups:",
				"  --device-name NAME      Name this computer in Iteration",
				"  --workspace ID          Connect to this workspace without a prompt",
				"  --codex-home DIR        Use a different Codex data directory",
				"  --claude-home DIR       Use a different Claude data directory",
				"  --cursor-home DIR       Use a different Cursor data directory",
				"  --yes                  Approve uploads without a terminal prompt",
				"  --data-directory DIR   Use a different state directory with a source-specific command",
				"  --endpoint URL         Use a different Iteration server",
			].join("\n") + "\n",
		);
		return;
	}
	process.stdout.write(
		[
			"Iteration CLI",
			"",
			"Get started:",
			"  iteration connect         Connect detected agents and import sessions",
			"",
			"Commands:",
			"  iteration                 See connection status",
			"  iteration status          See scan, upload, and error details",
			"  iteration connect codex|claude|cursor  Connect one source (advanced)",
			"  iteration disconnect codex|claude|cursor  Stop a source",
			"  iteration update          Update now (updates also install automatically)",
			"  iteration update off|on   Turn automatic updates off or on",
			"  iteration version         Show the installed version",
			"",
			"Run iteration connect --help for advanced setup options.",
		].join("\n") + "\n",
	);
}

async function fileExists(filename: string): Promise<boolean> {
	try {
		await fs.access(filename);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw new Error(`Could not inspect collector file at ${filename}.`, {
			cause: error,
		});
	}
}

async function defaultCommand(): Promise<void> {
	const snapshots = await Promise.all(
		COLLECTOR_SOURCES.map(async (source) => ({
			source,
			snapshot: await statusSnapshot(source, {}),
		})),
	);
	const connected = snapshots.filter(
		({ snapshot }) => snapshot.kind !== "not_connected",
	);
	if (connected.length > 0) {
		process.stdout.write(
			`${connected.map(({ source, snapshot }) => renderHome(snapshot, Date.now(), source)).join("\n\n")}\n`,
		);
		const discovered = await detectedSources({
			codex: sourceHome("codex"),
			claude: sourceHome("claude"),
			cursor: sourceHome("cursor"),
		});
		const missing = discovered.filter(
			(source) =>
				snapshots.find((item) => item.source === source)?.snapshot.kind ===
				"not_connected",
		);
		if (missing.length > 0) {
			process.stdout.write(
				`\n${missing.map(collectorSourceLabel).join(" and ")} found on this computer but not connected. Run iteration connect to include ${missing.length === 1 ? "it" : "them"}.\n`,
			);
		}
		return;
	}
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		process.stdout.write("Run iteration connect in a terminal.\n");
		return;
	}
	await connectAll({});
}

function dataDirectory(
	source: CollectorSource,
	values: Readonly<Record<string, string | boolean | undefined>>,
): string {
	return path.resolve(
		optionalString(values, "data-directory") ??
			defaultCollectorDirectory(source),
	);
}

async function turnSummaryNotice(config: CollectorConfig): Promise<string> {
	if ("cursorHome" in config)
		return " Cursor hooks capture tool results and usage automatically.";
	try {
		await installTurnSummary(config);
		if ((await codexTurnSummaryApproval(config)) === "needs_approval") {
			return "\nOne more step: in Codex, type /hooks and approve Iteration to see your friction summary after each turn.";
		}
		return " A one-line friction summary now appears after agent turns in your repositories.";
	} catch (error) {
		return ` The turn summary could not be installed: ${error instanceof Error ? error.message : "unknown error"} Run iteration start ${collectorSource(config)} to retry it.`;
	}
}

async function initialize(
	source: CollectorSource,
	values: Readonly<Record<string, string | boolean | undefined>>,
): Promise<CollectorConfig> {
	requireCollectorPlatform();
	const endpoint =
		optionalString(values, "endpoint") ?? DEFAULT_INGEST_ENDPOINT;
	const endpointUrl = validateCollectorEndpoint(endpoint);
	const deviceName = optionalString(values, "device-name") ?? os.hostname();
	const organizationId = optionalString(values, "workspace");
	const directory = dataDirectory(source, values);
	const paths = collectorPaths(directory);
	const selectedHome = path.resolve(
		source === "codex"
			? (optionalString(values, "codex-home") ??
					process.env.CODEX_HOME ??
					path.join(os.homedir(), ".codex"))
			: source === "claude"
				? (optionalString(values, "claude-home") ??
					process.env.CLAUDE_CONFIG_DIR ??
					path.join(os.homedir(), ".claude"))
				: (optionalString(values, "cursor-home") ??
					path.join(os.homedir(), ".cursor")),
	);
	await assertFreshCollectorDirectory(paths, source);
	const preparedState = await prepareSourceInitialState(
		source,
		selectedHome,
		true,
	);
	await prepareBackgroundPersistence();
	const enrollment = await authenticateAndEnrollCollector(
		endpointUrl,
		deviceName,
		organizationId,
		source,
	);
	const connection = {
		endpoint: endpointUrl.toString(),
		token: enrollment.token,
		dataDirectory: directory,
		organizationId: enrollment.organizationId,
		organizationName: enrollment.organizationName,
	};
	const config: CollectorConfig =
		source === "codex"
			? { ...connection, codexHome: selectedHome }
			: source === "claude"
				? { ...connection, source: "claude", claudeHome: selectedHome }
				: { ...connection, source: "cursor", cursorHome: selectedHome };
	await saveConfig(config, paths);
	try {
		await saveState(preparedState, paths);
		if (source === "cursor") await installCursorHooks(selectedHome, directory);
	} catch (error) {
		throw new Error(
			`Collector access was approved, but local setup did not finish. Run iteration start ${source} to repair it.`,
			{ cause: error },
		);
	}
	try {
		await installBackgroundService(directory, source);
	} catch (error) {
		throw new Error(
			`Collector access was approved, but background startup failed. Run iteration start ${source} to retry it.`,
			{ cause: error },
		);
	}
	const notice = await turnSummaryNotice(config);
	process.stdout.write(
		`${collectorSourceLabel(source)} is connected to ${enrollment.organizationName}. Existing sessions are importing, newest first, and new activity is collected automatically. Iteration shows the import as it runs.${notice}\n`,
	);
	return config;
}

async function approveAllSources(
	sources: readonly Readonly<{ source: CollectorSource; sessions: number }>[],
	workspaceName: string | null,
	yes: boolean,
): Promise<void> {
	const names = sources
		.map(
			({ source, sessions }) =>
				`${collectorSourceLabel(source)} (${sessions.toLocaleString("en-US")} saved ${sessions === 1 ? "session" : "sessions"})`,
		)
		.join(" and ");
	const safeName = safeWorkspaceName(workspaceName);
	process.stdout.write(
		`Detected ${names || "no saved agent sessions"} on this computer.\n` +
			`Connect supported agents${safeName ? ` to ${safeName}` : " to the workspace you select"}? Existing sessions and future activity, including prompts, code, and tool output, will be uploaded. Workspace members can read them. Newly detected supported agents will connect automatically.${process.platform === "linux" ? " Collection will continue after you log out." : ""}\n`,
	);
	if (yes) return;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			"Run iteration connect interactively or pass --yes to approve uploads.",
		);
	}
	const prompt = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = (await prompt.question("Connect agents? [y/N] "))
			.trim()
			.toLowerCase();
		if (answer !== "y" && answer !== "yes")
			throw new Error("No agents were connected.");
	} finally {
		prompt.close();
	}
}

async function connectAll(
	values: Readonly<Record<string, string | boolean | undefined>>,
): Promise<void> {
	requireCollectorPlatform();
	if (values["data-directory"] !== undefined) {
		throw new Error(
			"--data-directory requires a source-specific connect command.",
		);
	}
	const configs = await Promise.all(COLLECTOR_SOURCES.map(connectedConfig));
	const resolveSourceHomes = (): MachineConsent["sourceHomes"] => ({
		codex: path.resolve(
			optionalString(values, "codex-home") ??
				(configs[0] && "codexHome" in configs[0]
					? configs[0].codexHome
					: sourceHome("codex")),
		),
		claude: path.resolve(
			optionalString(values, "claude-home") ??
				(configs[1] && "claudeHome" in configs[1]
					? configs[1].claudeHome
					: sourceHome("claude")),
		),
		cursor: path.resolve(
			optionalString(values, "cursor-home") ??
				(configs[2] && "cursorHome" in configs[2]
					? configs[2].cursorHome
					: sourceHome("cursor")),
		),
	});
	const sourceHomes = resolveSourceHomes();
	const detected = await detectedSources(sourceHomes);
	const existing = COLLECTOR_SOURCES.flatMap((source, index) =>
		configs[index] ? [{ source, config: configs[index]! }] : [],
	);
	if (detected.length === 0 && existing.length === 0) {
		process.stdout.write(
			"No supported local coding agents found yet. Run iteration connect after using Codex, Claude Code, or Cursor on this computer.\n",
		);
		return;
	}
	const anchorSource = existing[0]?.source ?? detected[0]!;
	const anchorExisting = existing[0]?.config ?? null;
	const endpoint = validateCollectorEndpoint(
		optionalString(values, "endpoint") ??
			anchorExisting?.endpoint ??
			DEFAULT_INGEST_ENDPOINT,
	).toString();
	const existingScopes = await Promise.all(
		existing.map(async (item) => ({
			...item,
			scope: await readCollectorScope(item.config),
		})),
	);
	const validateWorkspace = () => {
		for (const item of existingScopes) {
			if (item.config.endpoint !== endpoint) {
				throw new Error(
					"Existing sources use different Iteration servers. Connect one source at a time.",
				);
			}
			if (
				existingScopes[0]?.scope.organizationId !== item.scope.organizationId
			) {
				throw new Error(
					"Existing sources use different workspaces. Connect one source at a time.",
				);
			}
		}
		const requestedOrganizationId = optionalString(values, "workspace");
		if (
			requestedOrganizationId &&
			existingScopes[0] &&
			requestedOrganizationId !== existingScopes[0].scope.organizationId
		) {
			throw new Error(
				"The existing collector belongs to a different workspace.",
			);
		}
	};
	validateWorkspace();
	const requestedOrganizationId = optionalString(values, "workspace");
	const previousConsent = await loadMachineConsent();
	const approveConnection = async () => {
		const needsApproval = () =>
			previousConsent === null ||
			anchorExisting === null ||
			previousConsent.endpoint !== endpoint ||
			previousConsent.anchorSource !== anchorSource ||
			previousConsent.anchorDataDirectory !== anchorExisting.dataDirectory ||
			previousConsent.organizationId !==
				existingScopes[0]?.scope.organizationId ||
			previousConsent.sourceHomes.codex !== sourceHomes.codex ||
			previousConsent.sourceHomes.claude !== sourceHomes.claude ||
			previousConsent.sourceHomes.cursor !== sourceHomes.cursor;
		if (needsApproval()) {
			await approveAllSources(
				await Promise.all(
					detected.map(async (source) => ({
						source,
						sessions: await countSavedSessions(source, sourceHomes[source]),
					})),
				),
				existingScopes[0]?.scope.organizationName ?? null,
				values.yes === true,
			);
		}
	};
	await approveConnection();
	await prepareBackgroundPersistence();
	let anchor = anchorExisting ?? (await initialize(anchorSource, values));
	let organizationId =
		requestedOrganizationId ??
		existingScopes[0]?.scope.organizationId ??
		anchor.organizationId ??
		null;
	const connectDetectedSources = async () => {
		for (const source of detected) {
			if (
				source === anchorSource ||
				configs[COLLECTOR_SOURCES.indexOf(source)] !== null
			)
				continue;
			const paths = collectorPaths(defaultCollectorDirectory(source));
			await assertFreshCollectorDirectory(paths, source);
			const state = await prepareSourceInitialState(
				source,
				sourceHomes[source],
				true,
			);
			const enrollment = await expandSource(anchor, source, organizationId);
			const config = await activateSource(
				source,
				sourceHomes[source],
				endpoint,
				enrollment,
				state,
			);
			organizationId = enrollment.organizationId;
			const notice = await turnSummaryNotice(config);
			process.stdout.write(
				`${collectorSourceLabel(source)} is connected to ${enrollment.organizationName}.${notice}\n`,
			);
		}
	};
	await connectDetectedSources();
	if (organizationId === null) {
		organizationId = (await readCollectorScope(anchor)).organizationId;
	}
	if (anchor.organizationId === undefined) {
		anchor = { ...anchor, organizationId };
		await saveConfig(anchor, collectorPaths(anchor.dataDirectory));
	}
	await saveMachineConsent({
		version: 1,
		endpoint,
		organizationId,
		anchorSource,
		anchorDataDirectory: anchor.dataDirectory,
		sourceHomes,
	});
	for (const item of existing) {
		await ensureStartableState(
			item.config,
			collectorPaths(item.config.dataDirectory),
		);
		if ("cursorHome" in item.config)
			await installCursorHooks(
				item.config.cursorHome,
				item.config.dataDirectory,
			);
		await installBackgroundService(item.config.dataDirectory, item.source);
		const notice = await turnSummaryNotice(item.config);
		process.stdout.write(
			`${collectorSourceLabel(item.source)} is still connected.${notice}\n`,
		);
	}
	process.stdout.write(
		"Detected agents are connected. New supported agents on this computer will connect automatically.\n",
	);
}

async function importHistory(
	source: CollectorSource,
	values: Readonly<Record<string, string | boolean | undefined>>,
): Promise<void> {
	requireCollectorPlatform();
	const directory = dataDirectory(source, values);
	const paths = collectorPaths(directory);
	const config = await loadConfig(paths);
	if (collectorSource(config) !== source)
		throw new Error(
			`This collector directory belongs to ${collectorSource(config)}.`,
		);
	const estimate = (await importSourceHistory(config, paths, false)).size;
	process.stdout.write(
		`Found ${estimate.files} local ${source} session files (${estimate.bytes} bytes). History may include prompts, code, and tool output that workspace members can read.\n`,
	);
	if (values.yes !== true) {
		process.stdout.write(
			`No changes made. Run iteration import-history ${source} --yes to confirm this upload.\n`,
		);
		return;
	}
	const result = await importSourceHistory(config, paths, true);
	process.stdout.write(
		`History scan scheduled for ${result.size.files} local session files (${result.size.bytes} bytes). Scanning and uploads run in bounded batches and may take time. Older sessions appear under the date Iteration receives them. Use iteration status ${source} to see local scan progress and pending uploads.${result.backgroundRunning ? "" : ` The collector was not running; run iteration start ${source} to begin scanning.`}\n`,
	);
}

async function start(
	source: CollectorSource,
	values: Readonly<Record<string, string | boolean | undefined>>,
): Promise<void> {
	requireCollectorPlatform();
	const directory = dataDirectory(source, values);
	const paths = collectorPaths(directory);
	const config = await loadConfig(paths);
	if (collectorSource(config) !== source)
		throw new Error(
			`This collector directory belongs to ${collectorSource(config)}.`,
		);
	const repairedState = await ensureStartableState(config, paths);
	if ("cursorHome" in config)
		await installCursorHooks(config.cursorHome, config.dataDirectory);
	await installBackgroundService(directory, source);
	const notice = await turnSummaryNotice(config);
	process.stdout.write(
		`${collectorSourceLabel(source)} is collecting again. Run iteration to check progress.${repairedState ? " Incomplete setup was repaired." : ""}${notice}\n`,
	);
}

async function statusSnapshot(
	source: CollectorSource,
	values: Readonly<Record<string, string | boolean | undefined>>,
): Promise<CliStatus> {
	const paths = collectorPaths(dataDirectory(source, values));
	if (!(await fileExists(paths.config))) {
		const [stateExists, pendingBytes] = await Promise.all([
			fileExists(paths.state),
			outboxSize(paths),
		]);
		if (stateExists || pendingBytes > 0) {
			return { kind: "needs_repair", pendingBytes, configPath: paths.config };
		}
		return { kind: "not_connected" };
	}
	const config = await loadConfig(paths);
	if (collectorSource(config) !== source)
		throw new Error(
			`This collector directory belongs to ${collectorSource(config)}.`,
		);
	const [running, size, ids, scan, localHealth, approval, hookFailureAtMs] =
		await Promise.all([
			backgroundServiceStatus(source),
			outboxSize(paths),
			pendingEventIds(paths),
			historyScanProgress(collectorSourceDirectory(config), paths, source),
			healthSnapshot(paths),
			codexTurnSummaryApproval(config),
			source === "cursor"
				? cursorHookFailureAtMs(config.dataDirectory)
				: source === "claude"
					? claudeGitHookFailureAtMs(config.dataDirectory)
					: Promise.resolve(null),
		]);
	const pendingEvents = size === 0 ? 0 : ids.size;
	const pendingBytes = ids.size === 0 ? 0 : size;
	return {
		kind: "connected",
		workspaceName: config.organizationName ?? null,
		running,
		scan,
		pendingEvents,
		pendingBytes,
		health: localHealth.health,
		healthAvailable: localHealth.kind === "available",
		turnSummaryNeedsApproval: approval === "needs_approval",
		hookFailureAtMs,
		tracesUrl: new URL("/app/sessions", config.endpoint).toString(),
		logPath: collectorLogPath(source),
	};
}

async function status(
	source: CollectorSource | undefined,
	values: Readonly<Record<string, string | boolean | undefined>>,
): Promise<void> {
	if (source !== undefined) {
		const snapshot = await statusSnapshot(source, values);
		process.stdout.write(
			`${renderDetailedStatus(snapshot, Date.now(), source)}\n`,
		);
		return;
	}
	const snapshots = await Promise.all(
		COLLECTOR_SOURCES.map(async (item) => ({
			source: item,
			snapshot: await statusSnapshot(item, values),
		})),
	);
	process.stdout.write(
		`${snapshots.map(({ source: item, snapshot }) => renderDetailedStatus(snapshot, Date.now(), item)).join("\n\n")}\n`,
	);
}

const ROLLBACK_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

async function runtimeSummaryText(): Promise<string | null> {
	const paths = runtimePaths();
	const state = await readRuntimeState(paths);
	if (state === null) return null;
	const settings = await readRuntimeSettings(paths);
	const rejected = state.rejected.at(-1);
	return renderRuntime({
		version: state.current,
		autoUpdate: settings.autoUpdate,
		confirming: state.trial?.version ?? null,
		rolledBack:
			rejected !== undefined && Date.now() - rejected.atMs < ROLLBACK_NOTICE_MS
				? { version: rejected.version, reason: rejected.reason }
				: null,
		checkError: state.lastCheck?.error ?? null,
	});
}

// A global package older than the version collectors run hands every
// command to the installed version, so commands and collectors always agree.
async function delegateToInstalledVersion(): Promise<number | null> {
	if (process.env.ITERATION_RUNTIME_VERSION !== undefined) return null;
	if (process.argv[2] === "run") return null;
	if (!isCollectorPlatform()) return null;
	const paths = runtimePaths();
	const state = await readRuntimeState(paths);
	if (state === null) return null;
	if (compareVersions(state.current, await ownVersion()) <= 0) return null;
	const result = spawnSync(
		process.execPath,
		[versionEntry(paths, state.current, "cli.js"), ...process.argv.slice(2)],
		{
			stdio: "inherit",
			env: { ...process.env, ITERATION_RUNTIME_VERSION: state.current },
		},
	);
	if (result.error !== undefined) throw result.error;
	return result.status ?? 1;
}

// Proves this version can read every connected source's local data. The
// updater runs it on a downloaded release before switching to it.
async function selfCheck(): Promise<void> {
	for (const source of COLLECTOR_SOURCES) {
		const paths = collectorPaths(defaultCollectorDirectory(source));
		if (!(await fileExists(paths.config))) continue;
		const config = await loadConfig(paths);
		if (collectorSource(config) !== source)
			throw new Error(
				`The ${source} collector directory holds another source.`,
			);
		await Promise.all([
			loadState(paths),
			pendingEventIds(paths),
			healthSnapshot(paths),
		]);
	}
	const paths = runtimePaths();
	await Promise.all([readRuntimeState(paths), readRuntimeSettings(paths)]);
	process.stdout.write(`${await ownVersion()}\n`);
}

const TRIAL_WAIT_MS = 150_000;

async function waitForTrial(to: string): Promise<string> {
	const deadline = Date.now() + TRIAL_WAIT_MS;
	while (Date.now() < deadline) {
		const state = await readRuntimeState(runtimePaths());
		if (state !== null && state.current !== to) {
			const rejected = state.rejected.find((item) => item.version === to);
			throw new Error(
				`Version ${to} did not start and Iteration returned to ${state.current}. ${rejected?.reason ?? ""}`.trim(),
			);
		}
		if (state?.trial === null) return `Iteration is updated to ${to}.`;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return `Iteration is updated to ${to}; collectors are still starting. Run iteration to check.`;
}

async function update(
	setting: string | undefined,
	values: Readonly<Record<string, string | boolean | undefined>>,
): Promise<void> {
	requireCollectorPlatform();
	const paths = runtimePaths();
	const registry = optionalString(values, "registry");
	if (setting !== undefined || registry !== null) {
		if (setting !== undefined && setting !== "on" && setting !== "off")
			throw new Error(
				"Run iteration update, iteration update on, or iteration update off.",
			);
		const settings = await readRuntimeSettings(paths);
		await writeRuntimeSettings(paths, {
			...settings,
			...(setting === undefined ? {} : { autoUpdate: setting === "on" }),
			...(registry === null
				? {}
				: { registry: validateRegistryUrl(registry).toString() }),
		});
		process.stdout.write(
			setting === "off"
				? "Automatic updates are off. Run iteration update to update.\n"
				: setting === "on"
					? "Automatic updates are on.\n"
					: "The update registry is saved.\n",
		);
		return;
	}
	await adoptRuntime();
	const expected = await installedServiceSources();
	if (expected.length === 0)
		throw new Error(
			"No collector is set up on this computer. Run iteration connect first.",
		);
	const outcome = await updateRuntime(paths, {
		manual: true,
		expected,
		nowMs: Date.now(),
		signal: AbortSignal.timeout(600_000),
	});
	if (outcome.kind === "busy") {
		process.stdout.write(
			"Another update is in progress. Run iteration to check.\n",
		);
		return;
	}
	if (outcome.kind === "up_to_date") {
		process.stdout.write(
			`Iteration ${outcome.version} is the latest version.\n`,
		);
		return;
	}
	if (outcome.kind === "waiting") {
		process.stdout.write(`No update was installed: ${outcome.reason}.\n`);
		return;
	}
	await refreshBackgroundServices(true);
	process.stdout.write(`${await waitForTrial(outcome.to)}\n`);
}

async function runInternalCommand(): Promise<boolean> {
	if (process.argv[2] === "supervise") {
		const source = process.argv[3];
		const directory = process.argv[5];
		if (
			(source !== "codex" && source !== "claude" && source !== "cursor") ||
			process.argv[4] !== "--data-directory" ||
			!directory ||
			process.argv.length !== 6
		) {
			throw new Error("Invalid collector supervisor command.");
		}
		await superviseCollector(source, directory);
		return true;
	}
	if (process.argv[2] === "claude-git-hook") {
		const directory = process.argv[3];
		if (!directory || process.argv.length !== 4)
			throw new Error("Invalid Claude Git hook command.");
		try {
			await captureClaudeGit(directory);
		} catch (error) {
			await recordClaudeGitHookFailure(directory);
			throw error;
		}
		return true;
	}
	if (process.argv[2] === "turn-summary-hook") {
		const directory = process.argv[3];
		if (!directory || process.argv.length !== 4)
			throw new Error("Invalid turn summary hook command.");
		await captureTurnSummary(directory);
		return true;
	}
	return false;
}

async function main(): Promise<void> {
	if (await runInternalCommand()) return;
	const delegated = await delegateToInstalledVersion();
	if (delegated !== null) {
		process.exitCode = delegated;
		return;
	}
	return dispatchCommand(argumentsForCli());
}

async function dispatchCommand({
	command,
	source,
	values,
}: ReturnType<typeof argumentsForCli>): Promise<void> {
	const selectedSource =
		source === "codex" || source === "claude" || source === "cursor"
			? source
			: null;
	if (values.help === true || command === "help") {
		return usage(command === "help" ? source : command);
	}
	if (
		values["include-history"] === true &&
		!(command === "connect" && selectedSource !== null)
	) {
		throw new Error(
			"Existing sessions are included automatically. Run iteration to connect.",
		);
	}
	if (command === "connect" && source === undefined) {
		return connectAll(values);
	}
	if (command === "") {
		return showHome(values);
	}
	if (command === "version") {
		const state = await readRuntimeState(runtimePaths());
		process.stdout.write(`${state?.current ?? (await ownVersion())}\n`);
		return;
	}
	if (command === "self-check") return selfCheck();
	if (command === "update") return update(source, values);
	return dispatchSourceCommand(command, source, values, selectedSource);
}

async function showHome(
	values: ReturnType<typeof argumentsForCli>["values"],
): Promise<void> {
	if (Object.keys(values).length > 0) {
		throw new Error(
			"Options require a source. Run iteration connect --help for details.",
		);
	}
	if (isCollectorPlatform()) await adoptRuntime();
	await defaultCommand();
	const summary = await runtimeSummaryText();
	if (summary !== null) process.stdout.write(`\n${summary}\n`);
}

async function disconnect(
	selectedSource: CollectorSource,
	values: ReturnType<typeof argumentsForCli>["values"],
): Promise<void> {
	await uninstallBackgroundService(selectedSource);
	const paths = collectorPaths(dataDirectory(selectedSource, values));
	if (await fileExists(paths.config)) {
		const config = await loadConfig(paths);
		if ("cursorHome" in config)
			await uninstallCursorHooks(config.cursorHome, config.dataDirectory);
		else await uninstallTurnSummary(config);
	}
	process.stdout.write(
		"Collector startup removed. Local pending data was retained.\n",
	);
}

async function dispatchSourceCommand(
	command: string,
	source: string | undefined,
	values: ReturnType<typeof argumentsForCli>["values"],
	selectedSource: CollectorSource | null,
): Promise<void> {
	const validateSourceOptions = () => {
		if (selectedSource !== null) {
			for (const name of ["codex", "claude", "cursor"] as const)
				if (selectedSource !== name && values[`${name}-home`] !== undefined)
					throw new Error(
						`--${name}-home requires the ${collectorSourceLabel(name)} source.`,
					);
		}
	};
	validateSourceOptions();
	if (command === "connect" && selectedSource !== null) {
		await initialize(selectedSource, values);
		return;
	}
	if (command === "run") {
		if (source !== undefined && selectedSource === null)
			throw new Error("The run source must be codex, claude, or cursor.");
		return runCollector(
			optionalString(values, "data-directory") ?? undefined,
			selectedSource ?? undefined,
		);
	}
	if (
		command === "status" &&
		(source === undefined || selectedSource !== null)
	) {
		return showStatus(source, selectedSource, values);
	}
	if (command === "import-history" && selectedSource !== null)
		return importHistory(selectedSource, values);
	if (command === "start" && selectedSource !== null)
		return start(selectedSource, values);
	if (command === "disconnect" && selectedSource !== null) {
		return disconnect(selectedSource, values);
	}
	throw new Error(
		`Unknown Iteration command: ${[command, source].filter(Boolean).join(" ")}. Run iteration help for usage.`,
	);
}

async function showStatus(
	source: string | undefined,
	selectedSource: CollectorSource | null,
	values: ReturnType<typeof argumentsForCli>["values"],
): Promise<void> {
	if (source === undefined && values["data-directory"] !== undefined)
		throw new Error("--data-directory requires a source with status.");
	requireCollectorPlatform();
	await adoptRuntime();
	await status(selectedSource ?? undefined, values);
	const summary = await runtimeSummaryText();
	if (summary !== null) process.stdout.write(`\n${summary}\n`);
}

// A background collector must end when its loop ends: the supervisor restarts
// it on the installed version, and a lingering process would block that.
const background = process.argv[2] === "run";
main().then(
	() => {
		if (background) process.exit(process.exitCode ?? 0);
	},
	(error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Unknown Iteration CLI error."}\n`,
		);
		process.exitCode = 1;
		if (background) process.exit(1);
	},
);
