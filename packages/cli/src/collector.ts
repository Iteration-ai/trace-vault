import { collectorLogger } from "./logger.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
	parseTraceEventAcknowledgement,
	type CollectorSource,
	type TraceEvent,
	type VaultCapturePolicy,
} from "iteration-trace-contracts";
import { type CollectorFetcher, collectorFetch } from "./collector-fetch.js";
import { fetchVaultPolicy } from "./vault-api.js";
import {
	authorizeVaultRecord,
	reauthorizeVaultEvent,
	scopeVaultEvents,
} from "./vault-scope.js";
import {
	ClaudeAccountIndex,
	loadClaudeAccountLedger,
} from "./claude-account.js";
import {
	parseClaudeGitHookLine,
	parseClaudeLine,
} from "./claude-transcript.js";
import { claudeGitHookFiles } from "./claude-git-hook.js";
import { cursorHookFiles } from "./cursor-hooks.js";
import {
	parseCursorHookLine,
	parseCursorTranscriptLine,
} from "./cursor-transcript.js";
import { redactTraceEvent } from "./redact-trace.js";
import { parseRolloutLine } from "./rollout.js";
import {
	acknowledgeEvents,
	appendEvents,
	collectorSource,
	collectorSourceDirectory,
	loadState,
	nextBatch,
	outboxSize,
	pendingEventIds,
	redactPendingOutbox,
	rewritePendingEvents,
	sourceFilesNewestFirst,
	saveState,
	type CollectorConfig,
	type CollectorPaths,
	type CollectorState,
} from "./storage.js";

const MAX_SCAN_BYTES_PER_FILE = 16 * 1024 * 1024;
const MAX_SCAN_BYTES_PER_TICK = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 3 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_EVENT_BYTES = MAX_UPLOAD_BYTES - 1024;
const MAX_UPLOADS_PER_TICK = 5;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
// Production stores some batches in about 40 seconds. Abandoning a request
// earlier does not stop the server, so the retry only waits behind it and the
// collector reports a failure for work that succeeded.
const UPLOAD_TIMEOUT_MS = 90_000;
// A tick can queue up to MAX_SCAN_BYTES_PER_TICK of new events, so scanning
// pauses well below the outbox capacity and resumes once uploads drain it.
const SCAN_PAUSE_OUTBOX_BYTES = 32 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type HistoryProgress = Readonly<{
	sessions: number;
	readSessions: number;
}>;

export class TraceUploadError extends Error {
	readonly kind: "http" | "network" | "response";
	readonly status: number | null;

	constructor(
		kind: "http" | "network" | "response",
		status: number | null,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "TraceUploadError";
		this.kind = kind;
		this.status = status;
	}
}

function logGap(
	source: CollectorSource,
	filename: string,
	offset: number,
	reason: string,
): void {
	collectorLogger({
		level: "warning",
		operation: "capture_gap",
		source,
		filename,
		offset,
		reason,
	});
}

function parseSourceRecord(
	source: CollectorSource,
	line: string,
	filename: string,
	byteOffset: number,
): Readonly<{ events: readonly TraceEvent[]; gaps: readonly string[] }> {
	if (source === "claude")
		return filename.includes(`${path.sep}git-queue${path.sep}`)
			? parseClaudeGitHookLine(line, filename)
			: parseClaudeLine(line, filename, byteOffset);
	if (source === "cursor")
		return filename.includes(`${path.sep}cursor-hooks${path.sep}`)
			? parseCursorHookLine(line, filename)
			: parseCursorTranscriptLine(line, filename, byteOffset);
	if (source === "codex") {
		const parsed = parseRolloutLine(line, filename, byteOffset);
		return parsed.kind === "event"
			? { events: [parsed.event], gaps: [] }
			: parsed.kind === "gap"
				? { events: [], gaps: [parsed.reason] }
				: { events: [], gaps: [] };
	}
	const unhandled: never = source;
	throw new Error(`Unsupported collector source: ${unhandled}`);
}

async function vaultAccountIndex(
	config: CollectorConfig,
): Promise<ClaudeAccountIndex | null> {
	return config.destination === "vault" && collectorSource(config) === "claude"
		? new ClaudeAccountIndex(
				await loadClaudeAccountLedger(config.dataDirectory),
			)
		: null;
}

async function scanCaptureState(
	config: CollectorConfig,
	state: CollectorState,
	policy: VaultCapturePolicy | undefined,
	accounts: ClaudeAccountIndex | null | undefined,
) {
	if (config.destination === "vault" && policy === undefined)
		throw new Error(
			"Company vault scanning requires a current capture policy.",
		);
	const cwds: Record<string, string> = { ...state.captureCwds };
	const accountIndex =
		accounts === undefined ? await vaultAccountIndex(config) : accounts;
	return {
		cwds,
		accounts: accountIndex,
		persistEvidence: async () => {
			await accountIndex?.persistNativeTools(config.dataDirectory);
		},
		checkpoint:
			policy === undefined
				? {}
				: { captureCwds: cwds, captureRevision: policy.revision },
	};
}

export async function scanSourceOnce(
	config: CollectorConfig,
	paths: CollectorPaths,
	signal?: AbortSignal,
	policy?: VaultCapturePolicy,
	accounts?: ClaudeAccountIndex | null,
): Promise<
	Readonly<{
		discovered: number;
		excludedRecords: number;
		caughtUp: boolean;
		history: HistoryProgress;
	}>
> {
	signal?.throwIfAborted();
	const source = collectorSource(config);
	const sourceDirectory = path.resolve(collectorSourceDirectory(config));
	const state = await loadState(paths);
	const captureState = await scanCaptureState(config, state, policy, accounts);
	if (!state.initialized || state.sourceDirectory !== sourceDirectory) {
		throw new Error(
			`Collector state does not match the ${source} directory; run iteration connect ${source} again.`,
		);
	}
	const cursors: Record<string, number> = { ...state.cursors };
	const captureCwds = captureState.cwds;
	const skipping = new Set(state.skipping);
	const sessionFiles = await sourceFilesNewestFirst(source, sourceDirectory);
	const listedSizes = new Map(
		sessionFiles.map((file) => [file.filename, file.size]),
	);
	const files = [
		...(source === "claude"
			? await claudeGitHookFiles(config.dataDirectory)
			: []),
		...sessionFiles.map((file) => file.filename),
		...(source === "cursor" ? await cursorHookFiles(config.dataDirectory) : []),
	];
	const completedHooks: string[] = [];
	const queuedIds = await pendingEventIds(paths);
	const tickIndexes = new Map<string, number>();
	const events: TraceEvent[] = [];
	const queueRecordEvents = async (
		parsedEvents: readonly TraceEvent[],
		filename: string,
		byteOffset: number,
	) => {
		for (const parsedEvent of parsedEvents) {
			// Claude repeats usage for a response; only the last copy is final.
			const queuedAt = tickIndexes.get(parsedEvent.eventId);
			if (
				queuedAt !== undefined &&
				parsedEvent.eventType === "token_usage_record"
			) {
				const event = await redactTraceEvent(parsedEvent);
				if (Buffer.byteLength(JSON.stringify(event), "utf8") <= MAX_EVENT_BYTES)
					events[queuedAt] = event;
				continue;
			}
			if (queuedIds.has(parsedEvent.eventId)) continue;
			const event = await redactTraceEvent(parsedEvent);
			const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
			if (eventBytes > MAX_EVENT_BYTES) {
				logGap(
					source,
					filename,
					byteOffset,
					"normalized_event_exceeds_upload_limit",
				);
			} else {
				tickIndexes.set(event.eventId, events.length);
				events.push(event);
				queuedIds.add(event.eventId);
			}
		}
	};
	let remainingBudget = MAX_SCAN_BYTES_PER_TICK;
	let excludedRecords = 0;
	let caughtUp = true;
	for (const filename of files) {
		signal?.throwIfAborted();
		const recordLimit = isCursorHookFile(source, filename)
			? 12 * 1024 * 1024
			: MAX_RECORD_BYTES;
		if (remainingBudget === 0) {
			caughtUp = false;
			break;
		}
		const size = listedSizes.get(filename) ?? (await fs.stat(filename)).size;
		let offset = cursors[filename] ?? 0;
		if (offset > size) {
			logGap(source, filename, offset, "rollout_file_shrank_resetting_cursor");
			offset = 0;
			skipping.delete(filename);
			delete captureCwds[filename];
		}
		const bytesToRead = Math.min(
			size - offset,
			MAX_SCAN_BYTES_PER_FILE,
			remainingBudget,
		);
		if (bytesToRead === 0) {
			cursors[filename] = offset;
			continue;
		}
		const handle = await fs.open(filename, "r");
		let buffer: Buffer;
		let readEnd = offset;
		try {
			buffer = Buffer.alloc(bytesToRead);
			const result = await handle.read(buffer, 0, bytesToRead, offset);
			buffer = buffer.subarray(0, result.bytesRead);
			readEnd = offset + result.bytesRead;
			remainingBudget -= result.bytesRead;
		} finally {
			await handle.close();
		}
		if (readEnd < size) caughtUp = false;
		if (skipping.has(filename)) {
			delete captureCwds[filename];
			const newline = buffer.indexOf(10);
			if (newline < 0) {
				cursors[filename] = offset + buffer.length;
				continue;
			}
			offset += newline + 1;
			buffer = buffer.subarray(newline + 1);
			skipping.delete(filename);
		}
		const scanRecords = async () => {
			let lineStart = 0;
			for (let index = 0; index < buffer.length; index += 1) {
				if (buffer[index] !== 10) continue;
				let lineBytes = buffer.subarray(lineStart, index);
				if (lineBytes.at(-1) === 13) lineBytes = lineBytes.subarray(0, -1);
				const byteOffset = offset + lineStart;
				if (lineBytes.length > recordLimit) {
					delete captureCwds[filename];
					logGap(
						source,
						filename,
						byteOffset,
						"rollout_record_exceeds_scan_limit",
					);
					lineStart = index + 1;
					continue;
				}
				let line: string;
				try {
					line = UTF8_DECODER.decode(lineBytes);
				} catch {
					delete captureCwds[filename];
					logGap(source, filename, byteOffset, "rollout_record_is_not_utf8");
					lineStart = index + 1;
					continue;
				}
				const capture =
					policy === undefined
						? undefined
						: authorizeVaultRecord(
								policy,
								source,
								line,
								filename,
								captureCwds,
								captureState.accounts,
							);
				if (capture === null) {
					excludedRecords += 1;
					lineStart = index + 1;
					continue;
				}
				const parsed = parseSourceRecord(source, line, filename, byteOffset);
				for (const reason of parsed.gaps)
					logGap(source, filename, byteOffset, reason);
				await queueRecordEvents(
					scopeVaultEvents(parsed.events, capture, line),
					filename,
					byteOffset,
				);
				lineStart = index + 1;
			}
			if (buffer.length - lineStart > recordLimit) {
				delete captureCwds[filename];
				logGap(
					source,
					filename,
					offset + lineStart,
					"incomplete_rollout_record_exceeds_scan_limit",
				);
				skipping.add(filename);
				lineStart = buffer.length;
			}
			cursors[filename] = offset + lineStart;
		};
		await scanRecords();
		if (isConsumedHook(source, filename, policy) && cursors[filename] === size)
			completedHooks.push(filename);
	}
	await captureState.persistEvidence();
	await appendEvents(events, paths);
	for (const filename of completedHooks) {
		await fs.rm(filename);
		delete cursors[filename];
	}
	await saveState(
		{
			...state,
			cursors,
			...captureState.checkpoint,
			skipping: [...skipping],
			sourceDirectory: state.sourceDirectory,
			initialized: true,
		},
		paths,
	);
	const sessions = sessionFiles.filter((file) => file.session);
	return {
		discovered: events.length,
		excludedRecords,
		caughtUp,
		history: {
			sessions: sessions.length,
			readSessions: sessions.filter(
				(file) => (cursors[file.filename] ?? 0) >= file.size,
			).length,
		},
	};
}

function isConsumedHook(
	source: CollectorSource,
	filename: string,
	policy: VaultCapturePolicy | undefined,
): boolean {
	if (policy !== undefined) return false;
	return (
		isCursorHookFile(source, filename) ||
		(source === "claude" &&
			filename.includes(`${path.sep}git-queue${path.sep}`))
	);
}

function isCursorHookFile(source: CollectorSource, filename: string): boolean {
	return (
		source === "cursor" &&
		filename.includes(`${path.sep}cursor-hooks${path.sep}`)
	);
}

function retryAfterMs(response: Response): number | null {
	const header = response.headers.get("retry-after");
	if (header === null) return null;
	const milliseconds = /^\d+$/.test(header)
		? Number(header) * 1000
		: Date.parse(header) - Date.now();
	return Number.isFinite(milliseconds)
		? Math.max(1000, Math.min(milliseconds, 300_000))
		: 5000;
}

async function uploadPendingOnce(
	config: CollectorConfig,
	paths: CollectorPaths,
	fetcher: CollectorFetcher = collectorFetch,
	signal?: AbortSignal,
	onAcknowledged?: () => void,
	policy?: VaultCapturePolicy,
): Promise<Readonly<{ uploaded: number; retryAfterMs: number | null }>> {
	let uploaded = 0;
	for (let attempt = 0; attempt < MAX_UPLOADS_PER_TICK; attempt += 1) {
		signal?.throwIfAborted();
		await recheckQueuedAccounts(config, paths, policy);
		const batch = await nextBatch(paths, MAX_UPLOAD_BYTES);
		if (batch.length === 0) return { uploaded, retryAfterMs: null };
		const body = JSON.stringify({ events: batch });
		if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
			throw new Error("Queued trace batch exceeds the upload request limit.");
		}
		let response: Response;
		try {
			response = await fetcher(config.endpoint, {
				method: "POST",
				headers: {
					authorization: `Bearer ${config.token}`,
					"content-type": "application/json",
				},
				body,
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)])
					: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new TraceUploadError(
				"network",
				null,
				config.destination === "vault"
					? "Trace upload could not reach the company vault."
					: "Trace upload could not reach Iteration.",
				{ cause: error },
			);
		}
		if (response.status === 429) {
			await response.body?.cancel();
			return { uploaded, retryAfterMs: retryAfterMs(response) ?? 5000 };
		}
		if (response.status !== 202) {
			throw new TraceUploadError(
				"http",
				response.status,
				`Trace upload failed with HTTP ${response.status}.`,
			);
		}
		let acknowledgement: unknown;
		try {
			acknowledgement = await response.json();
		} catch (error) {
			throw new TraceUploadError(
				"response",
				null,
				"Trace upload returned an unreadable acknowledgement.",
				{ cause: error },
			);
		}
		const expectedIds = batch.map((event) => event.eventId);
		const parsed = parseTraceEventAcknowledgement(acknowledgement, expectedIds);
		if (!parsed.success) {
			throw new TraceUploadError("response", null, parsed.error);
		}
		await acknowledgeEvents(new Set(parsed.value.acceptedEventIds), paths);
		onAcknowledged?.();
		uploaded += batch.length;
		const pause = retryAfterMs(response);
		if (pause !== null) return { uploaded, retryAfterMs: pause };
	}
	return { uploaded, retryAfterMs: null };
}

async function recheckQueuedAccounts(
	config: CollectorConfig,
	paths: CollectorPaths,
	policy: VaultCapturePolicy | undefined,
): Promise<void> {
	if (policy === undefined || collectorSource(config) !== "claude") return;
	const accounts = await vaultAccountIndex(config);
	await rewritePendingEvents(paths, (event) =>
		reauthorizeVaultEvent(policy, event, accounts),
	);
}

export async function collectorTick(
	config: CollectorConfig,
	paths: CollectorPaths,
	fetcher: CollectorFetcher = collectorFetch,
	signal?: AbortSignal,
	onAcknowledged?: () => void,
): Promise<
	Readonly<{
		discovered: number;
		excludedRecords: number;
		uploaded: number;
		outboxBytes: number;
		historyCaughtUp: boolean;
		history: HistoryProgress | null;
		retryAfterMs: number;
	}>
> {
	const accounts = await vaultAccountIndex(config);
	const policy =
		config.destination === "vault"
			? await fetchVaultPolicy(config.endpoint, config.token, fetcher, signal)
			: undefined;
	if (policy !== undefined) {
		// Unscoped legacy queues never inherit permission from this device.
		await rewritePendingEvents(paths, (event) =>
			reauthorizeVaultEvent(policy, event, accounts),
		);
		const state = await loadState(paths);
		if (
			state.captureRevision !== policy.revision ||
			(state.captureEvidenceGeneration !== (accounts?.generation ?? 0) &&
				state.captureRecheckAt !== undefined) ||
			(state.captureRecheckAt !== undefined &&
				state.captureRecheckAt <= Date.now())
		) {
			await saveState(
				{
					...state,
					cursors: {},
					skipping: [],
					captureCwds: {},
					captureRevision: policy.revision,
					captureEvidenceGeneration: accounts?.generation ?? 0,
					captureRecheckAt: undefined,
				},
				paths,
			);
		}
	}
	await redactPendingOutbox(paths);
	let upload = await uploadPendingOnce(
		config,
		paths,
		fetcher,
		signal,
		onAcknowledged,
		policy,
	);
	const scan =
		(await outboxSize(paths)) >= SCAN_PAUSE_OUTBOX_BYTES
			? { discovered: 0, excludedRecords: 0, caughtUp: false, history: null }
			: await scanSourceOnce(config, paths, signal, policy, accounts);
	if (policy !== undefined && scan.caughtUp) {
		const state = await loadState(paths);
		if (state.captureRecheckAt === undefined)
			await saveState(
				{ ...state, captureRecheckAt: Date.now() + 300_000 },
				paths,
			);
	}
	if (upload.retryAfterMs === null) {
		const next = await uploadPendingOnce(
			config,
			paths,
			fetcher,
			signal,
			onAcknowledged,
			policy,
		);
		upload = { ...next, uploaded: upload.uploaded + next.uploaded };
	}
	return {
		discovered: scan.discovered,
		excludedRecords: scan.excludedRecords,
		uploaded: upload.uploaded,
		outboxBytes: await outboxSize(paths),
		historyCaughtUp: scan.caughtUp,
		history: scan.history,
		retryAfterMs: upload.retryAfterMs ?? 0,
	};
}
