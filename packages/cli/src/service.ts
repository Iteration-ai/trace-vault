import { collectorLogger } from "./logger.js";
import { ensurePrivateDirectory } from "./private-storage.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	CollectorHistoryProgress,
	CollectorSource,
} from "iteration-trace-contracts";
import {
	connectNewDetectedSources,
	loadMachineConsent,
} from "./auto-connect.js";
import { collectorFetch } from "./collector-fetch.js";
import { collectorTick, TraceUploadError } from "./collector.js";
import { HistoryProgressReporter } from "./history-progress.js";
import { installTurnSummary, refreshTurnSummaries } from "./turn-summary.js";
import { installCursorHooks } from "./cursor-hooks.js";
import { syncCursorBilling } from "./cursor-billing.js";
import { syncCodexBilling } from "./codex-billing.js";
import { installedServiceSources } from "./background-service.js";
import { confirmRuntimeTrial, expireRuntimeTrial } from "./runtime-install.js";
import {
	readRuntimeSettings,
	readRuntimeState,
	runtimePaths,
} from "./runtime.js";
import { UPDATE_CHECK_INTERVAL_MS, updateRuntime } from "./updater.js";
import {
	collectorSource,
	collectorPaths,
	ensureClaudeHistoryBackfill,
	ensureCursorHistoryBackfill,
	ensureHistoryBackfill,
	healthSnapshot,
	loadConfig,
	saveHealth,
	type CollectorFailure,
	type CollectorHealth,
	type CollectorPaths,
} from "./storage.js";

function errorCode(error: unknown): string | null {
	if (error instanceof Error && "code" in error) return String(error.code);
	return null;
}

class CollectorLockBusyError extends Error {}

// Fetch reports network failures as a generic TypeError; the actionable
// reason (DNS, TLS, reset, timeout) is only in its cause chain.
function errorCauses(
	error: unknown,
): Readonly<{ name: string; code: string | null; message: string }>[] {
	const causes = [];
	let current = error instanceof Error ? error.cause : undefined;
	while (current instanceof Error && causes.length < 4) {
		causes.push({
			name: current.name,
			code: errorCode(current),
			message: current.message.slice(0, 300),
		});
		current = current.cause;
	}
	return causes;
}

function collectorFailure(error: unknown): CollectorFailure {
	return {
		atMs: Date.now(),
		kind: error instanceof TraceUploadError ? error.kind : "collector",
		status: error instanceof TraceUploadError ? error.status : null,
	};
}

async function persistHealth(
	health: CollectorHealth,
	paths: CollectorPaths,
): Promise<void> {
	try {
		await saveHealth(health, paths);
	} catch {
		collectorLogger({
			level: "warning",
			operation: "save_collector_health",
			message:
				"Local collector status could not be saved; collection continues.",
		});
	}
}

export async function acquireCollectorLock(
	paths: CollectorPaths,
): Promise<() => Promise<void>> {
	await ensurePrivateDirectory(path.dirname(paths.lock));
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(paths.lock, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`, "utf8");
			await handle.sync();
			await handle.close();
			return async () => {
				const current = await fs.readFile(paths.lock, "utf8").catch(() => "");
				if (current.trim() === String(process.pid)) {
					await fs.rm(paths.lock, { force: true });
				}
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const lockContents = await fs
				.readFile(paths.lock, "utf8")
				.catch(() => "");
			const lockPid = Number(lockContents.trim());
			if (!Number.isSafeInteger(lockPid) || lockPid < 2) {
				await fs.rm(paths.lock, { force: true });
				continue;
			}
			try {
				process.kill(lockPid, 0);
				throw new CollectorLockBusyError("Collector is already running.");
			} catch (processError) {
				if (errorCode(processError) !== "ESRCH") throw processError;
				await fs.rm(paths.lock, { force: true });
			}
		}
	}
	throw new Error("Could not obtain the collector lock.");
}

export async function waitForCollectorLock(
	paths: CollectorPaths,
): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 81; attempt += 1) {
		try {
			return await acquireCollectorLock(paths);
		} catch (error) {
			if (!(error instanceof CollectorLockBusyError)) throw error;
			if (attempt === 80) {
				throw new Error(
					"Collector did not stop within 20 seconds; history was not changed.",
					{ cause: error },
				);
			}
			await delay(250);
		}
	}
	throw new Error("Could not obtain the collector lock.");
}

const RUNTIME_CHECK_INTERVAL_MS = 60_000;

// Collectors started by the launcher follow the installed version: they exit
// for the supervisor to restart them when it changes, and the one that finds
// a due update installs it and exits.
async function runtimeStep(
	version: string,
	signal: AbortSignal,
): Promise<"continue" | "restart"> {
	const paths = runtimePaths();
	const nowMs = Date.now();
	await expireRuntimeTrial(nowMs, paths);
	const state = await readRuntimeState(paths);
	if (state === null || state.current !== version) return "restart";
	if (state.trial !== null) return "continue";
	if (!(await readRuntimeSettings(paths)).autoUpdate) return "continue";
	if (
		state.lastCheck !== null &&
		nowMs - state.lastCheck.atMs < UPDATE_CHECK_INTERVAL_MS
	)
		return "continue";
	const outcome = await updateRuntime(paths, {
		manual: false,
		expected: await installedServiceSources(),
		nowMs,
		signal,
	});
	if (outcome.kind !== "updated") return "continue";
	collectorLogger({
		level: "info",
		operation: "runtime_update",
		from: outcome.from,
		to: outcome.to,
	});
	return "restart";
}

// Network failures and server errors say nothing about the new version, but
// the server rejecting its requests or any local failure does.
function versionFailure(error: unknown): boolean {
	if (!(error instanceof TraceUploadError)) return true;
	return (
		error.kind === "http" &&
		error.status !== null &&
		error.status >= 400 &&
		error.status < 500 &&
		![401, 403, 408, 429].includes(error.status)
	);
}

// A collector on trial that fails for a reason other than the network or
// server exits, so the launcher counts the failed start.
async function onTrial(version: string): Promise<boolean> {
	const state = await readRuntimeState(runtimePaths());
	return state?.trial?.version === version;
}

export async function runCollector(
	directory?: string,
	expectedSource?: CollectorSource,
): Promise<void> {
	const paths = collectorPaths(directory);
	const releaseLock = await acquireCollectorLock(paths);
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	let retryDelayMs = 5000;
	try {
		const config = await loadConfig(paths);
		const source = collectorSource(config);
		if (expectedSource !== undefined && expectedSource !== source) {
			throw new Error(
				`Collector directory belongs to ${source}, not ${expectedSource}.`,
			);
		}
		const loadedHealth = await healthSnapshot(paths);
		let health = loadedHealth.health;
		if (loadedHealth.kind === "unavailable") {
			collectorLogger({
				level: "warning",
				operation: "load_collector_health",
				message:
					"Local collector status could not be read; collection continues.",
			});
		}
		if ("cursorHome" in config) {
			await ensureCursorHistoryBackfill(config.cursorHome, paths);
			await installCursorHooks(config.cursorHome, config.dataDirectory);
		} else if ("claudeHome" in config) {
			await ensureClaudeHistoryBackfill(config.claudeHome, paths);
			await installTurnSummary(config);
		} else await ensureHistoryBackfill(config.codexHome, paths);
		const summariesRefreshedAt = new Map<
			string,
			Readonly<{ directory: string; atMs: number }>
		>();
		let lastAutoCheckAt = 0;
		let lastBillingSyncAt = 0;
		const historyProgress = new HistoryProgressReporter();
		const runtimeVersion = process.env.ITERATION_RUNTIME_VERSION;
		let lastRuntimeCheckAt = 0;
		let trialSettled = runtimeVersion === undefined;
		const checkRuntime = async (): Promise<boolean> => {
			if (
				runtimeVersion !== undefined &&
				Date.now() - lastRuntimeCheckAt >= RUNTIME_CHECK_INTERVAL_MS
			) {
				lastRuntimeCheckAt = Date.now();
				let step: "continue" | "restart" = "continue";
				try {
					step = await runtimeStep(runtimeVersion, controller.signal);
				} catch (error) {
					if (controller.signal.aborted) return false;
					collectorLogger({
						level: "error",
						source,
						operation: "runtime_update",
						causes: errorCauses(error),
						message:
							error instanceof Error
								? error.message
								: "The update check failed.",
					});
				}
				if (step === "restart") {
					collectorLogger({
						level: "info",
						source,
						operation: "runtime_restart",
					});
					return false;
				}
			}
			return true;
		};
		const connectDetectedSources = async () => {
			if (Date.now() - lastAutoCheckAt >= 60_000) {
				lastAutoCheckAt = Date.now();
				try {
					const consent = await loadMachineConsent();
					if (consent?.anchorSource === source) {
						const connected = await connectNewDetectedSources(config, consent);
						if (connected.length > 0) {
							collectorLogger({
								level: "info",
								operation: "auto_connect_sources",
								connected,
							});
						}
					}
				} catch (error) {
					collectorLogger({
						level: "error",
						operation: "auto_connect_sources",
						message:
							error instanceof Error
								? error.message
								: "Automatic source connection failed.",
					});
				}
			}
		};
		const recordTickSuccess = async (
			result: Awaited<ReturnType<typeof collectorTick>>,
			acknowledgedAtMs: number | null,
		) => {
			if (
				acknowledgedAtMs !== null ||
				health.lastFailure !== null ||
				(result.historyCaughtUp && health.historyCaughtUpAtMs === null)
			) {
				health = {
					lastUploadAtMs: acknowledgedAtMs ?? health.lastUploadAtMs,
					historyCaughtUpAtMs:
						health.historyCaughtUpAtMs ??
						(result.historyCaughtUp ? Date.now() : null),
					lastFailure: null,
				};
				await persistHealth(health, paths);
			}
			if (!trialSettled && runtimeVersion !== undefined) {
				await confirmRuntimeTrial(runtimeVersion, source);
				trialSettled = true;
			}
			if (result.discovered > 0 || result.uploaded > 0) {
				collectorLogger({
					level: "info",
					source,
					operation: "collector_tick",
					discovered: result.discovered,
					uploaded: result.uploaded,
					outboxBytes: result.outboxBytes,
				});
			}
			retryDelayMs = Math.max(5000, result.retryAfterMs);
			if (result.retryAfterMs > 0)
				retryDelayMs += Math.floor(Math.random() * 1000);
		};
		const collect = async () => {
			let acknowledgedAtMs: number | null = null;
			let billingReady = false;
			let history: CollectorHistoryProgress | null = null;
			try {
				const result = await collectorTick(
					config,
					paths,
					collectorFetch,
					controller.signal,
					() => {
						acknowledgedAtMs = Date.now();
					},
				);
				billingReady = result.historyCaughtUp && result.outboxBytes === 0;
				if (result.history !== null) {
					history = {
						...result.history,
						complete:
							billingReady &&
							result.history.readSessions === result.history.sessions,
					};
				}
				await recordTickSuccess(result, acknowledgedAtMs);
			} catch (error) {
				if (controller.signal.aborted) return null;
				if (!trialSettled && runtimeVersion !== undefined) {
					if (versionFailure(error) && (await onTrial(runtimeVersion)))
						throw error;
					await confirmRuntimeTrial(runtimeVersion, source);
					trialSettled = true;
				}
				health = {
					lastUploadAtMs: acknowledgedAtMs ?? health.lastUploadAtMs,
					historyCaughtUpAtMs: health.historyCaughtUpAtMs,
					lastFailure: collectorFailure(error),
				};
				collectorLogger({
					level: "error",
					source,
					operation: "collector_tick",
					errorName: error instanceof Error ? error.name : "UnknownError",
					causes: errorCauses(error),
					message:
						error instanceof Error
							? error.message
							: "Unknown collector failure.",
				});
				await persistHealth(health, paths);
				retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
			}
			return { history, billingReady };
		};
		const reportHistory = async (
			history: CollectorHistoryProgress | null,
		): Promise<boolean> => {
			if (history !== null) {
				try {
					await historyProgress.report(
						config,
						history,
						collectorFetch,
						controller.signal,
						Date.now(),
					);
				} catch (error) {
					if (controller.signal.aborted) return false;
					collectorLogger({
						level: "warning",
						source,
						operation: "report_history_progress",
						errorName: error instanceof Error ? error.name : "UnknownError",
						causes: errorCauses(error),
						message:
							error instanceof Error
								? error.message
								: "Unknown history progress failure.",
					});
				}
			}
			return true;
		};
		const refreshSummaries = async (): Promise<boolean> => {
			try {
				if (source !== "cursor")
					await refreshTurnSummaries(
						config,
						summariesRefreshedAt,
						Date.now(),
						collectorFetch,
						controller.signal,
					);
			} catch (error) {
				if (controller.signal.aborted) return false;
				collectorLogger({
					level: "warning",
					source,
					operation: "refresh_turn_summaries",
					errorName: error instanceof Error ? error.name : "UnknownError",
					causes: errorCauses(error),
					message:
						error instanceof Error
							? error.message
							: "Unknown turn summary failure.",
				});
			}
			return true;
		};
		const syncBilling = async (billingReady: boolean): Promise<boolean> => {
			if (
				"cursorHome" in config &&
				billingReady &&
				Date.now() - lastBillingSyncAt >= 6 * 60 * 60 * 1000
			) {
				try {
					const billing = await syncCursorBilling(
						config,
						collectorFetch,
						controller.signal,
					);
					lastBillingSyncAt = billing.skipped
						? Date.now() - 6 * 60 * 60 * 1000 + 5 * 60 * 1000
						: Date.now();
					collectorLogger({
						level: "info",
						operation: "sync_cursor_billing",
						...billing,
					});
				} catch (error) {
					if (controller.signal.aborted) return false;
					lastBillingSyncAt = Date.now() - 6 * 60 * 60 * 1000 + 5 * 60 * 1000;
					collectorLogger({
						level: "warning",
						operation: "sync_cursor_billing",
						message:
							error instanceof Error
								? error.message
								: "Cursor billing sync failed.",
					});
				}
			}
			if (
				"codexHome" in config &&
				billingReady &&
				Date.now() - lastBillingSyncAt >= 6 * 60 * 60 * 1000
			) {
				try {
					const billing = await syncCodexBilling(
						config,
						collectorFetch,
						controller.signal,
					);
					lastBillingSyncAt = billing.skipped
						? Date.now() - 6 * 60 * 60 * 1000 + 5 * 60 * 1000
						: Date.now();
					collectorLogger({
						level: "info",
						operation: "sync_codex_billing",
						...billing,
					});
				} catch (error) {
					if (controller.signal.aborted) return false;
					lastBillingSyncAt = Date.now() - 6 * 60 * 60 * 1000 + 5 * 60 * 1000;
					collectorLogger({
						level: "warning",
						operation: "sync_codex_billing",
						message:
							error instanceof Error
								? error.message
								: "Codex billing sync failed.",
					});
				}
			}
			return true;
		};
		while (!controller.signal.aborted) {
			if (!(await checkRuntime())) break;
			await connectDetectedSources();
			const result = await collect();
			if (result === null) break;
			if (!(await reportHistory(result.history))) break;
			if (!(await refreshSummaries())) break;
			if (!(await syncBilling(result.billingReady))) break;
			try {
				await delay(retryDelayMs, undefined, { signal: controller.signal });
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") break;
				throw error;
			}
		}
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		await releaseLock();
	}
}
