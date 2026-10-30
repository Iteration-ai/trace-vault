import {
	collectorSourceLabel,
	type CollectorSource,
} from "iteration-trace-contracts";
import type { CollectorHealth } from "./storage.js";

const CODEX_APPROVAL_STEP =
	"Friction summary is off: in Codex, type /hooks and approve Iteration.";

function sourceName(source: CollectorSource): string {
	return collectorSourceLabel(source);
}

type ScanProgress = Readonly<
	| { kind: "waiting" }
	| { kind: "scanning"; scannedBytes: number; totalBytes: number }
>;

export type CliStatus =
	| Readonly<{ kind: "not_connected" }>
	| Readonly<{
			kind: "needs_repair";
			pendingBytes: number;
			configPath: string;
	  }>
	| Readonly<{
			kind: "connected";
			workspaceName: string | null;
			running: boolean;
			scan: ScanProgress;
			pendingEvents: number;
			pendingBytes: number;
			health: CollectorHealth;
			healthAvailable: boolean;
			turnSummaryNeedsApproval: boolean;
			hookFailureAtMs?: number | null;
			tracesUrl: string;
			logPath: string;
	  }>;

export function safeWorkspaceName(value: string | null): string | null {
	const cleaned = value
		?.split("")
		.map((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || (code >= 127 && code <= 159) ? " " : character;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned === undefined || cleaned === "" ? null : cleaned;
}

function readableBytes(bytes: number): string {
	if (bytes < 1_000) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let amount = bytes;
	let index = -1;
	do {
		amount /= 1_000;
		index += 1;
	} while (amount >= 1_000 && index < units.length - 1);
	const precision = amount < 10 ? 1 : 0;
	return `${amount.toFixed(precision).replace(/\.0$/, "")} ${units[index]}`;
}

function relativeTime(atMs: number, nowMs: number): string {
	const elapsedSeconds = Math.max(0, Math.floor((nowMs - atMs) / 1_000));
	if (elapsedSeconds < 5) return "just now";
	if (elapsedSeconds < 60)
		return `${elapsedSeconds} second${elapsedSeconds === 1 ? "" : "s"} ago`;
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60)
		return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24)
		return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
	const elapsedDays = Math.floor(elapsedHours / 24);
	return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
}

function pendingDescription(
	status: Extract<CliStatus, { kind: "connected" }>,
): string {
	return `${status.pendingEvents} event${status.pendingEvents === 1 ? "" : "s"} (${readableBytes(status.pendingBytes)}) waiting on this computer`;
}

function progressDescription(
	scan: ScanProgress,
	source: CollectorSource,
): string {
	if (scan.kind === "waiting") return "Local history is preparing to scan.";
	if (scan.totalBytes === 0)
		return `No local ${sourceName(source)} sessions found yet.`;
	if (scan.scannedBytes >= scan.totalBytes)
		return `Local history scanned (${readableBytes(scan.totalBytes)}).`;
	const remainingBytes = scan.totalBytes - scan.scannedBytes;
	if (remainingBytes < 1_000_000)
		return "Local scan is nearly caught up (less than 1 MB remains).";
	const percentage = Math.min(
		99,
		Math.floor((scan.scannedBytes / scan.totalBytes) * 100),
	);
	return `About ${percentage}% of local history scanned (${readableBytes(scan.scannedBytes)} of ${readableBytes(scan.totalBytes)}).`;
}

function historyDescription(
	status: Extract<CliStatus, { kind: "connected" }>,
	source: CollectorSource,
): string {
	if (status.health.historyCaughtUpAtMs === null) {
		return progressDescription(status.scan, source);
	}
	if (status.scan.kind === "waiting") return "History is preparing to scan.";
	const remainingBytes = status.scan.totalBytes - status.scan.scannedBytes;
	if (remainingBytes <= 0)
		return "History imported; local files are caught up.";
	if (remainingBytes < 1_000_000)
		return "History imported; scanning current activity.";
	return `History imported; ${readableBytes(remainingBytes)} of new activity waiting to scan.`;
}

function failureDescription(
	status: Extract<CliStatus, { kind: "connected" }>,
	source: CollectorSource,
): Readonly<{ heading: string; explanation: string }> {
	const name = sourceName(source);
	const failure = status.health.lastFailure;
	if (failure === null) {
		throw new Error("A collector failure is required to describe it.");
	}
	if (failure.kind === "http") {
		const code =
			failure.status === null ? "HTTP error" : `HTTP ${failure.status}`;
		if (failure.status === 401 || failure.status === 403) {
			return {
				heading: `${name} upload access needs attention`,
				explanation: `Iteration denied this collector (${code}). Queued data stays on this computer. Contact Iteration support to reconnect it safely.`,
			};
		}
		if (
			failure.status !== null &&
			failure.status < 500 &&
			failure.status !== 429
		) {
			return {
				heading: `${name} uploads need attention`,
				explanation: `Iteration rejected an event batch (${code}). Check the collector log for details.`,
			};
		}
		return {
			heading: `${name} uploads are delayed`,
			explanation: `Iteration could not accept an upload (${code}). Retrying automatically.`,
		};
	}
	if (failure.kind === "network") {
		return {
			heading: `${name} uploads are delayed`,
			explanation: "Could not reach Iteration. Retrying automatically.",
		};
	}
	if (failure.kind === "response") {
		return {
			heading: `${name} uploads need attention`,
			explanation:
				"Iteration returned an unexpected upload response. Retrying automatically.",
		};
	}
	return {
		heading: `${name} collector needs attention`,
		explanation: `A local error interrupted collection. See iteration status ${source} for details.`,
	};
}

export function renderHome(
	status: CliStatus,
	nowMs = Date.now(),
	source: CollectorSource = "codex",
): string {
	const name = sourceName(source);
	if (status.kind === "not_connected") {
		return [
			"Iteration",
			"",
			`${name} is not connected.`,
			"Run iteration connect to import your existing sessions.",
		].join("\n");
	}
	if (status.kind === "needs_repair") {
		return [
			"Iteration",
			"",
			`${name} connection needs repair`,
			"Local collector data exists, but its connection details are missing.",
			status.pendingBytes > 0
				? `${readableBytes(status.pendingBytes)} of queued data remains on this computer.`
				: "Existing local progress remains on this computer.",
			`Run iteration status ${source} for recovery details.`,
		].join("\n");
	}
	const workspaceName = safeWorkspaceName(status.workspaceName);
	const lines = [
		workspaceName === null ? "Iteration" : `Iteration · ${workspaceName}`,
		"",
	];
	const appendConnectionStatus = (): boolean => {
		if (!status.running) {
			lines.push(`${name} is stopped`, "New sessions are not being collected.");
			if (status.pendingEvents > 0)
				lines.push(`${pendingDescription(status)}.`);
			lines.push(`Resume with iteration start ${source}.`);
		} else if (
			status.hookFailureAtMs !== null &&
			status.hookFailureAtMs !== undefined
		) {
			lines.push(
				`${name} hook capture needs attention`,
				`A ${name} hook failed ${relativeTime(status.hookFailureAtMs, nowMs)}. Some data may be missing. See iteration status ${source}.`,
			);
		} else if (!status.healthAvailable) {
			lines.push(
				`${name} is running; local status needs attention`,
				"Upload history could not be read. Collection continues in the background.",
			);
			if (status.pendingEvents > 0)
				lines.push(`${pendingDescription(status)}.`);
			lines.push(`Details: iteration status ${source}`);
		} else if (status.health.lastFailure !== null) {
			const failure = failureDescription(status, source);
			lines.push(failure.heading, failure.explanation);
			if (status.pendingEvents > 0)
				lines.push(`${pendingDescription(status)}.`);
			if (status.health.lastUploadAtMs !== null) {
				lines.push(
					`Last successful upload ${relativeTime(status.health.lastUploadAtMs, nowMs)}.`,
				);
			}
			lines.push(`Details: iteration status ${source}`);
		} else return false;
		return true;
	};
	const appendScanStatus = () => {
		if (status.scan.kind === "waiting") {
			lines.push(
				`${name} is preparing your history`,
				progressDescription(status.scan, source),
			);
		} else if (
			status.scan.kind === "scanning" &&
			status.scan.totalBytes > 0 &&
			status.scan.scannedBytes < status.scan.totalBytes &&
			status.health.historyCaughtUpAtMs === null
		) {
			lines.push(
				`${name} is importing existing sessions`,
				historyDescription(status, source),
				"New activity is collected automatically.",
			);
		} else if (
			status.scan.kind === "scanning" &&
			status.scan.totalBytes - status.scan.scannedBytes >= 1_000_000
		) {
			lines.push(
				`${name} is catching up with new activity`,
				historyDescription(status, source),
			);
			if (status.pendingEvents > 0)
				lines.push(`${pendingDescription(status)}.`);
		} else if (status.pendingEvents > 0) {
			lines.push(
				`${name} is uploading captured sessions`,
				`${pendingDescription(status)}.`,
			);
		} else if (status.scan.totalBytes === 0) {
			lines.push(
				`${name} is connected`,
				`Waiting for ${name} sessions on this computer.`,
			);
		} else if (
			status.scan.kind === "scanning" &&
			status.scan.scannedBytes < status.scan.totalBytes
		) {
			lines.push(
				`${name} is collecting new activity`,
				"Local history is imported; current activity is being scanned.",
			);
		} else {
			lines.push(
				`${name} is collecting`,
				"Local scan is caught up and no uploads are waiting.",
				"New activity is collected automatically.",
			);
		}
	};
	if (!appendConnectionStatus()) appendScanStatus();
	const appendLastUpload = () => {
		if (
			status.running &&
			status.health.lastFailure === null &&
			status.health.lastUploadAtMs !== null
		) {
			lines.push(
				`Last successful upload ${relativeTime(status.health.lastUploadAtMs, nowMs)}.`,
			);
		}
	};
	appendLastUpload();
	if (status.turnSummaryNeedsApproval) lines.push("", CODEX_APPROVAL_STEP);
	lines.push("", `Explore traces  ${status.tracesUrl}`);
	return lines.join("\n");
}

export function renderDetailedStatus(
	status: CliStatus,
	nowMs = Date.now(),
	source: CollectorSource = "codex",
): string {
	const name = sourceName(source);
	if (status.kind === "not_connected") {
		return `${name} is not connected. Run iteration connect to connect.`;
	}
	if (status.kind === "needs_repair") {
		return [
			`${name} connection needs repair`,
			"Local collector data exists without its connection details.",
			`Queued data: ${readableBytes(status.pendingBytes)}`,
			`Restore the missing config from backup: ${status.configPath}`,
			"If you do not have it, contact Iteration support before reconnecting; existing data has been kept.",
		].join("\n");
	}
	const workspaceName = safeWorkspaceName(status.workspaceName);
	const lines = [
		`${name} collector`,
		...(workspaceName === null ? [] : [`Workspace: ${workspaceName}`]),
		`Background process: ${status.running ? "Running" : "Stopped"}`,
		`History: ${historyDescription(status, source).replace(/^History /, "")}`,
		`Uploads: ${status.pendingEvents === 0 ? "None waiting" : pendingDescription(status)}`,
	];
	if (!status.healthAvailable) {
		lines.push(
			"Local status: unavailable; check collector file permissions",
			`Collector log: ${status.logPath}`,
		);
	}
	if (status.health.lastUploadAtMs !== null) {
		lines.push(
			`Last successful upload: ${relativeTime(status.health.lastUploadAtMs, nowMs)}`,
		);
	}
	if (status.health.lastFailure !== null) {
		const failure = status.health.lastFailure;
		const label =
			failure.kind === "http" && failure.status !== null
				? `HTTP ${failure.status}`
				: failure.kind === "network"
					? "Network unavailable"
					: failure.kind === "response"
						? "Unexpected upload response"
						: "Local collector error";
		lines.push(
			`Last issue: ${label} (${relativeTime(failure.atMs, nowMs)})`,
			`Collector log: ${status.logPath}`,
		);
	}
	if (status.hookFailureAtMs !== null && status.hookFailureAtMs !== undefined)
		lines.push(
			`Last ${name} hook capture failure: ${relativeTime(status.hookFailureAtMs, nowMs)}. Some data may be missing; inspect ${name} hook logs.`,
		);
	if (status.turnSummaryNeedsApproval) lines.push(CODEX_APPROVAL_STEP);
	if (!status.running) lines.push(`Resume: iteration start ${source}`);
	lines.push(`Explore traces: ${status.tracesUrl}`);
	return lines.join("\n");
}

export type RuntimeSummary = Readonly<{
	version: string;
	autoUpdate: boolean;
	confirming: string | null;
	rolledBack: Readonly<{ version: string; reason: string }> | null;
	checkError: string | null;
}>;

export function renderRuntime(summary: RuntimeSummary): string {
	return [
		`Iteration ${summary.version} · ${summary.autoUpdate ? "updates automatically" : "automatic updates are off; run iteration update to update"}`,
		...(summary.confirming === null
			? []
			: [`Starting version ${summary.confirming} after an update.`]),
		...(summary.rolledBack === null
			? []
			: [
					`Version ${summary.rolledBack.version} was rolled back: ${summary.rolledBack.reason}`,
				]),
		...(summary.checkError === null
			? []
			: [`Last update check failed: ${summary.checkError}`]),
	].join("\n");
}
