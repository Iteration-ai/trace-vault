import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
	type CollectorSource,
	MAX_TRACE_EVENTS_PER_BATCH,
	parseTraceEventBatch,
	type TraceEvent,
} from "iteration-trace-contracts";
import * as z from "zod";
import { redactTraceEvent } from "./redact-trace.js";
import { ensurePrivateDirectory } from "./private-storage.js";

const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;

type CollectorConnection = Readonly<{
	endpoint: string;
	token: string;
	dataDirectory: string;
	organizationId?: string;
	organizationName?: string;
	destination?: "vault";
}>;

export type CollectorConfig =
	| (CollectorConnection & Readonly<{ codexHome: string }>)
	| (CollectorConnection & Readonly<{ source: "claude"; claudeHome: string }>)
	| (CollectorConnection & Readonly<{ source: "cursor"; cursorHome: string }>);

export function collectorSource(config: CollectorConfig): CollectorSource {
	return "cursorHome" in config
		? "cursor"
		: "claudeHome" in config
			? "claude"
			: "codex";
}

export function collectorSourceDirectory(config: CollectorConfig): string {
	return "cursorHome" in config
		? config.cursorHome
		: "claudeHome" in config
			? config.claudeHome
			: config.codexHome;
}

export type CollectorState = Readonly<{
	cursors: Readonly<Record<string, number>>;
	skipping: readonly string[];
	sourceDirectory: string | null;
	initialized: boolean;
	captureRevision?: number;
	captureCwds?: Readonly<Record<string, string>>;
	captureRecheckAt?: number;
	captureEvidenceGeneration?: number;
}>;

export type CollectorFailure = Readonly<{
	atMs: number;
	kind: "http" | "network" | "response" | "collector";
	status: number | null;
}>;

export type CollectorHealth = Readonly<{
	lastUploadAtMs: number | null;
	historyCaughtUpAtMs: number | null;
	lastFailure: CollectorFailure | null;
}>;

export type HealthSnapshot = Readonly<
	| { kind: "available"; health: CollectorHealth }
	| { kind: "unavailable"; health: CollectorHealth }
>;

export type CollectorPaths = Readonly<{
	config: string;
	state: string;
	outbox: string;
	redactionMarker: string;
	lock: string;
	historyBackfill: string;
	health: string;
}>;

const connectionSchema = {
	endpoint: z.string(),
	token: z.string(),
	dataDirectory: z.string(),
	organizationId: z.uuid().optional(),
	organizationName: z.string().min(1).max(160).optional(),
	destination: z.literal("vault").optional(),
};
const configSchema = z.union([
	z.object({ ...connectionSchema, codexHome: z.string() }).strict(),
	z
		.object({
			...connectionSchema,
			source: z.literal("claude"),
			claudeHome: z.string(),
		})
		.strict(),
	z
		.object({
			...connectionSchema,
			source: z.literal("cursor"),
			cursorHome: z.string(),
		})
		.strict(),
]);

const stateSchema = z
	.object({
		cursors: z.record(
			z.string(),
			z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		),
		skipping: z.array(z.string()),
		sourceDirectory: z.string().nullable(),
		initialized: z.boolean(),
		captureRevision: z.number().int().positive().optional(),
		captureCwds: z.record(z.string(), z.string()).optional(),
		captureRecheckAt: z.number().int().nonnegative().optional(),
		captureEvidenceGeneration: z.number().int().nonnegative().optional(),
	})
	.strict();

const healthSchema = z
	.object({
		lastUploadAtMs: z.number().int().min(0).nullable(),
		historyCaughtUpAtMs: z.number().int().min(0).nullable(),
		lastFailure: z
			.object({
				atMs: z.number().int().min(0),
				kind: z.enum(["http", "network", "response", "collector"]),
				status: z.number().int().min(100).max(599).nullable(),
			})
			.strict()
			.nullable(),
	})
	.strict();

const redactionMarkerSchema = z.object({ version: z.literal(1) }).strict();

// readline treats U+2028 and U+2029 inside JSON strings as line endings on
// newer Node versions. Only LF separates records in the durable outbox.
async function* outboxLines(filename: string): AsyncGenerator<string> {
	const input = createReadStream(filename);
	let parts: Buffer[] = [];
	try {
		for await (const value of input) {
			const chunk: Buffer = value;
			let start = 0;
			let newline = chunk.indexOf(10);
			while (newline !== -1) {
				const end = chunk.subarray(start, newline);
				if (parts.length === 0) yield end.toString("utf8");
				else {
					parts.push(end);
					yield Buffer.concat(parts).toString("utf8");
					parts = [];
				}
				start = newline + 1;
				newline = chunk.indexOf(10, start);
			}
			if (start < chunk.length) parts.push(chunk.subarray(start));
		}
		if (parts.length > 0) yield Buffer.concat(parts).toString("utf8");
	} finally {
		input.destroy();
	}
}

function parseOutboxEvent(line: string): TraceEvent {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch (error) {
		throw new Error("Trace outbox contains a malformed record.", {
			cause: error,
		});
	}
	const parsed = parseTraceEventBatch({ events: [decoded] });
	if (!parsed.success)
		throw new Error(`Trace outbox event is invalid: ${parsed.error}`);
	const [event] = parsed.value.events;
	if (event === undefined) throw new Error("Trace outbox event is missing.");
	return event;
}

export function validateCollectorEndpoint(endpoint: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch (error) {
		throw new Error("Collector endpoint must be a valid URL.", {
			cause: error,
		});
	}
	const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(
		parsed.hostname,
	);
	if (
		parsed.username !== "" ||
		parsed.password !== "" ||
		(parsed.protocol !== "https:" &&
			!(parsed.protocol === "http:" && localHost))
	) {
		throw new Error("Collector endpoint must use HTTPS, except for localhost.");
	}
	if (
		parsed.pathname !== "/api/traces/ingest" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		throw new Error(
			"Collector endpoint must be the trace ingest route without query parameters.",
		);
	}
	return parsed;
}

export function collectorPaths(directory: string): CollectorPaths {
	return {
		config: path.join(directory, "config.json"),
		state: path.join(directory, "state.json"),
		outbox: path.join(directory, "outbox.jsonl"),
		redactionMarker: path.join(directory, "redaction.json"),
		lock: path.join(directory, "collector.lock"),
		historyBackfill: path.join(directory, "history-backfill.json"),
		health: path.join(directory, "health.json"),
	};
}

export async function assertFreshCollectorDirectory(
	paths: CollectorPaths,
	source: CollectorSource = "codex",
): Promise<void> {
	const state = await loadState(paths);
	const configExists = await fs
		.access(paths.config)
		.then(() => true)
		.catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return false;
			throw error;
		});
	if (configExists) {
		throw new Error(
			`This collector data directory is already configured for ${source}. Use your collector's status command with the same connection and --data-directory, or choose a different --data-directory for another workspace or vault.`,
		);
	}
	if (state.initialized || (await outboxSize(paths)) > 0) {
		throw new Error(
			"Collector state or pending events exist without a config. Use a different --data-directory; this data cannot be safely assigned to a new workspace.",
		);
	}
}

async function writeJsonAtomic(
	filename: string,
	value: unknown,
): Promise<void> {
	const temporary = `${filename}.${process.pid}.tmp`;
	const handle = await fs.open(temporary, "w", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, filename);
}

export async function saveConfig(
	config: CollectorConfig,
	paths: CollectorPaths,
): Promise<void> {
	await ensurePrivateDirectory(path.dirname(paths.config));
	await writeJsonAtomic(paths.config, config);
}

export async function loadHealth(
	paths: CollectorPaths,
): Promise<CollectorHealth> {
	let contents: string;
	try {
		contents = await fs.readFile(paths.health, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return {
				lastUploadAtMs: null,
				historyCaughtUpAtMs: null,
				lastFailure: null,
			};
		}
		throw new Error(`Could not read collector health at ${paths.health}.`, {
			cause: error,
		});
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error("Collector health is not valid JSON.", { cause: error });
	}
	const parsed = healthSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new Error("Collector health has an invalid shape.", {
			cause: parsed.error,
		});
	}
	return parsed.data;
}

export async function healthSnapshot(
	paths: CollectorPaths,
): Promise<HealthSnapshot> {
	try {
		return { kind: "available", health: await loadHealth(paths) };
	} catch {
		return {
			kind: "unavailable",
			health: {
				lastUploadAtMs: null,
				historyCaughtUpAtMs: null,
				lastFailure: null,
			},
		};
	}
}

export async function saveHealth(
	health: CollectorHealth,
	paths: CollectorPaths,
): Promise<void> {
	await ensurePrivateDirectory(path.dirname(paths.health));
	await writeJsonAtomic(paths.health, health);
}

export async function loadConfig(
	paths: CollectorPaths,
): Promise<CollectorConfig> {
	let contents: string;
	try {
		contents = await fs.readFile(paths.config, "utf8");
	} catch (error) {
		throw new Error(`Could not read collector config at ${paths.config}.`, {
			cause: error,
		});
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error("Collector config is not valid JSON.", { cause: error });
	}
	const parsed = configSchema.safeParse(decoded);
	if (!parsed.success)
		throw new Error("Collector config has an invalid shape.", {
			cause: parsed.error,
		});
	validateCollectorEndpoint(parsed.data.endpoint);
	const { token } = parsed.data;
	const tokenPattern =
		parsed.data.destination === "vault"
			? /^vd_[A-Za-z0-9_-]{43}$/
			: /^[A-Za-z0-9_-]{43}$/;
	if (!tokenPattern.test(token)) {
		throw new Error("Collector token has an invalid format.");
	}
	return parsed.data;
}

export async function loadState(
	paths: CollectorPaths,
): Promise<CollectorState> {
	let contents: string;
	try {
		contents = await fs.readFile(paths.state, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return {
				cursors: {},
				skipping: [],
				sourceDirectory: null,
				initialized: false,
			};
		}
		throw new Error(`Could not read collector checkpoint at ${paths.state}.`, {
			cause: error,
		});
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error("Collector checkpoint is not valid JSON.", {
			cause: error,
		});
	}
	const parsed = stateSchema.safeParse(decoded);
	if (!parsed.success)
		throw new Error("Collector checkpoint has an invalid shape.", {
			cause: parsed.error,
		});
	return parsed.data;
}

export async function saveState(
	state: CollectorState,
	paths: CollectorPaths,
): Promise<void> {
	await ensurePrivateDirectory(path.dirname(paths.state));
	await writeJsonAtomic(paths.state, state);
}

export async function outboxSize(paths: CollectorPaths): Promise<number> {
	try {
		return (await fs.stat(paths.outbox)).size;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return 0;
		throw new Error("Could not inspect the local trace outbox.", {
			cause: error,
		});
	}
}

export async function pendingEventIds(
	paths: CollectorPaths,
): Promise<Set<string>> {
	const ids = new Set<string>();
	const size = await outboxSize(paths);
	if (size > MAX_OUTBOX_BYTES)
		throw new Error("Trace outbox exceeds its configured capacity.");
	try {
		for await (const line of outboxLines(paths.outbox)) {
			ids.add(parseOutboxEvent(line).eventId);
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return ids;
		throw error;
	}
	return ids;
}

export async function appendEvents(
	events: readonly TraceEvent[],
	paths: CollectorPaths,
): Promise<void> {
	if (events.length === 0) return;
	const contents = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	const newSize = Buffer.byteLength(contents, "utf8");
	const currentSize = await outboxSize(paths);
	if (currentSize + newSize > MAX_OUTBOX_BYTES) {
		throw new Error(
			"Trace outbox is full; upload pending data before scanning more sessions.",
		);
	}
	await ensurePrivateDirectory(path.dirname(paths.outbox));
	const handle = await fs.open(paths.outbox, "a", 0o600);
	try {
		await handle.writeFile(contents, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function redactPendingOutbox(
	paths: CollectorPaths,
): Promise<void> {
	let marker: string | null;
	try {
		marker = await fs.readFile(paths.redactionMarker, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			marker = null;
		else throw error;
	}
	if (marker !== null) {
		let decoded: unknown;
		try {
			decoded = JSON.parse(marker);
		} catch {
			throw new Error("Collector redaction marker is not valid JSON.");
		}
		if (!redactionMarkerSchema.safeParse(decoded).success)
			throw new Error("Collector redaction marker has an invalid shape.");
		return;
	}
	const size = await outboxSize(paths);
	if (size > MAX_OUTBOX_BYTES)
		throw new Error("Trace outbox exceeds its configured capacity.");
	if (size > 0) {
		const temporary = `${paths.outbox}.${process.pid}.redacting`;
		const output = await fs.open(temporary, "w", 0o600);
		try {
			for await (const line of outboxLines(paths.outbox)) {
				const event = await redactTraceEvent(parseOutboxEvent(line));
				await output.writeFile(`${JSON.stringify(event)}\n`, "utf8");
			}
			await output.sync();
		} catch (error) {
			await output.close();
			await fs.rm(temporary, { force: true });
			throw error;
		}
		await output.close();
		try {
			if ((await fs.stat(temporary)).size > MAX_OUTBOX_BYTES)
				throw new Error(
					"Redacted trace outbox exceeds its configured capacity.",
				);
			await fs.rename(temporary, paths.outbox);
			// Directory handles cannot be fsynced on Windows; NTFS already
			// journals the rename.
			if (process.platform !== "win32") {
				const directory = await fs.open(path.dirname(paths.outbox), "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
		} catch (error) {
			await fs.rm(temporary, { force: true });
			throw error;
		}
	}
	await ensurePrivateDirectory(path.dirname(paths.redactionMarker));
	await writeJsonAtomic(paths.redactionMarker, { version: 1 });
}

export async function nextBatch(
	paths: CollectorPaths,
	maxBytes: number,
): Promise<readonly TraceEvent[]> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error("Maximum upload batch size must be a positive integer.");
	}
	const size = await outboxSize(paths);
	if (size === 0) return [];
	if (size > MAX_OUTBOX_BYTES)
		throw new Error("Trace outbox exceeds its configured capacity.");
	const events: TraceEvent[] = [];
	let bytes = 0;
	for await (const line of outboxLines(paths.outbox)) {
		const lineBytes = Buffer.byteLength(line, "utf8") + 1;
		if (
			events.length >= MAX_TRACE_EVENTS_PER_BATCH ||
			(events.length > 0 && bytes + lineBytes > maxBytes)
		) {
			break;
		}
		if (lineBytes > maxBytes) {
			throw new Error("A queued event exceeds the maximum upload batch size.");
		}
		events.push(parseOutboxEvent(line));
		bytes += lineBytes;
	}
	return events;
}

export async function acknowledgeEvents(
	acknowledgedIds: ReadonlySet<string>,
	paths: CollectorPaths,
): Promise<void> {
	await rewritePendingEvents(paths, (event) =>
		acknowledgedIds.has(event.eventId) ? null : event,
	);
}

export async function rewritePendingEvents(
	paths: CollectorPaths,
	transform: (event: TraceEvent) => TraceEvent | null,
): Promise<void> {
	if ((await outboxSize(paths)) === 0) return;
	const temporary = `${paths.outbox}.${process.pid}.tmp`;
	try {
		await pipeline(
			outboxLines(paths.outbox),
			async function* (lines: AsyncIterable<string>) {
				for await (const line of lines) {
					const event = transform(parseOutboxEvent(line));
					if (event !== null) yield `${JSON.stringify(event)}\n`;
				}
			},
			createWriteStream(temporary, { flags: "w", mode: 0o600 }),
		);
		const durable = await fs.open(temporary, "r+");
		try {
			await durable.sync();
		} finally {
			await durable.close();
		}
		await fs.rename(temporary, paths.outbox);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

export async function initializeState(
	source: CollectorSource,
	home: string,
	paths: CollectorPaths,
	includeHistory: boolean,
): Promise<void> {
	const state = await loadState(paths);
	const sourceDirectory = path.resolve(home);
	if (state.initialized && state.sourceDirectory !== sourceDirectory) {
		throw new Error(
			`Collector state belongs to another ${source} directory; use a separate --data-directory.`,
		);
	}
	if (state.initialized && state.sourceDirectory === sourceDirectory) {
		if (includeHistory) {
			throw new Error(
				`${source} is already connected. Import existing sessions explicitly instead of reconnecting.`,
			);
		}
		return;
	}
	await saveState(
		await prepareSourceInitialState(source, home, includeHistory),
		paths,
	);
}

export async function prepareSourceInitialState(
	source: CollectorSource,
	home: string,
	includeHistory: boolean,
): Promise<CollectorState> {
	const sourceDirectory = path.resolve(home);
	const files = await sourceFiles(source, sourceDirectory);
	const cursors: Record<string, number> = {};
	if (!includeHistory) {
		for (const filename of files) {
			cursors[filename] = await lastCompleteRecordOffset(
				filename,
				(await fs.stat(filename)).size,
			);
		}
	}
	return {
		cursors,
		skipping: [],
		sourceDirectory,
		initialized: true,
	};
}

export async function ensureStartableState(
	config: CollectorConfig,
	paths: CollectorPaths,
): Promise<boolean> {
	const source = collectorSource(config);
	const directory = collectorSourceDirectory(config);
	const state = await loadState(paths);
	if (state.initialized) {
		if (state.sourceDirectory !== path.resolve(directory)) {
			throw new Error(
				`Collector state belongs to another ${source} directory; use a separate --data-directory.`,
			);
		}
		return false;
	}
	if ((await outboxSize(paths)) > 0) {
		throw new Error(
			"Pending events exist without an initialized checkpoint; repair the collector state before starting uploads.",
		);
	}
	await saveState(
		await prepareSourceInitialState(source, directory, true),
		paths,
	);
	return true;
}

const HISTORY_BACKFILL_VERSION = 4;
const historyBackfillMarkerSchema = z
	.object({ version: z.number().int().min(1).max(HISTORY_BACKFILL_VERSION) })
	.strict();

async function readHistoryBackfillVersion(
	paths: CollectorPaths,
): Promise<number | null> {
	let marker: string | null;
	try {
		marker = await fs.readFile(paths.historyBackfill, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
		return null;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(marker);
	} catch (error) {
		throw new Error("Collector history backfill marker is not valid JSON.", {
			cause: error,
		});
	}
	const parsed = historyBackfillMarkerSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new Error("Collector history backfill marker has an invalid shape.", {
			cause: parsed.error,
		});
	}
	return parsed.data.version;
}

export async function ensureHistoryBackfill(
	codexHome: string,
	paths: CollectorPaths,
): Promise<boolean> {
	const version = await readHistoryBackfillVersion(paths);
	if (version !== null && version >= HISTORY_BACKFILL_VERSION) return false;
	const state = await loadState(paths);
	if (!state.initialized || state.sourceDirectory !== path.resolve(codexHome)) {
		throw new Error(
			"Collector state does not match CODEX_HOME; reconnect Codex before uploading.",
		);
	}
	await rolloutFiles(path.join(codexHome, "sessions"));
	await saveState({ ...state, cursors: {}, skipping: [] }, paths);
	await writeJsonAtomic(paths.historyBackfill, {
		version: HISTORY_BACKFILL_VERSION,
	});
	return true;
}

// Version 3 re-reads Claude history so stored sessions gain each response's
// final usage report and the PR links Claude records.
const CLAUDE_HISTORY_BACKFILL_VERSION = 3;

export async function ensureClaudeHistoryBackfill(
	claudeHome: string,
	paths: CollectorPaths,
): Promise<boolean> {
	const version = await readHistoryBackfillVersion(paths);
	if (version !== null && version >= CLAUDE_HISTORY_BACKFILL_VERSION)
		return false;
	const state = await loadState(paths);
	if (
		!state.initialized ||
		state.sourceDirectory !== path.resolve(claudeHome)
	) {
		throw new Error(
			"Collector state does not match the Claude directory; reconnect Claude before uploading.",
		);
	}
	await claudeFiles(path.join(claudeHome, "projects"));
	await saveState({ ...state, cursors: {}, skipping: [] }, paths);
	await writeJsonAtomic(paths.historyBackfill, {
		version: CLAUDE_HISTORY_BACKFILL_VERSION,
	});
	return true;
}

export async function ensureCursorHistoryBackfill(
	cursorHome: string,
	paths: CollectorPaths,
): Promise<boolean> {
	const version = await readHistoryBackfillVersion(paths);
	if (version !== null && version >= 1) return false;
	const state = await loadState(paths);
	if (!state.initialized || state.sourceDirectory !== path.resolve(cursorHome))
		throw new Error(
			"Collector state does not match the Cursor directory; reconnect Cursor before uploading.",
		);
	await cursorFiles(path.join(cursorHome, "projects"));
	await saveState({ ...state, cursors: {}, skipping: [] }, paths);
	await writeJsonAtomic(paths.historyBackfill, { version: 1 });
	return true;
}

export async function historyScanProgress(
	home: string,
	paths: CollectorPaths,
	source: CollectorSource = "codex",
): Promise<
	Readonly<
		| { kind: "waiting" }
		| { kind: "scanning"; scannedBytes: number; totalBytes: number }
	>
> {
	if ((await readHistoryBackfillVersion(paths)) === null)
		return { kind: "waiting" };
	const state = await loadState(paths);
	if (!state.initialized || state.sourceDirectory !== path.resolve(home)) {
		throw new Error(`Collector state does not match the ${source} directory.`);
	}
	const files = await sourceFiles(source, home);
	let scannedBytes = 0;
	let totalBytes = 0;
	for (let start = 0; start < files.length; start += 64) {
		const batch = files.slice(start, start + 64);
		const sizes = await Promise.all(
			batch.map(async (filename) => {
				try {
					return (await fs.stat(filename)).size;
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
						return null;
					throw error;
				}
			}),
		);
		for (const [index, size] of sizes.entries()) {
			if (size === null) continue;
			const filename = batch[index];
			if (filename === undefined) continue;
			totalBytes += size;
			const cursor = state.cursors[filename] ?? 0;
			scannedBytes += cursor <= size ? cursor : 0;
			if (
				!Number.isSafeInteger(totalBytes) ||
				!Number.isSafeInteger(scannedBytes)
			) {
				throw new Error(`${source} history size exceeds the supported limit.`);
			}
		}
	}
	return { kind: "scanning", scannedBytes, totalBytes };
}

export async function resetHistoryCursors(
	home: string,
	paths: CollectorPaths,
	source: CollectorSource = "codex",
): Promise<Readonly<{ files: number; bytes: number }>> {
	const state = await loadState(paths);
	const sourceDirectory = path.resolve(home);
	if (!state.initialized || state.sourceDirectory !== sourceDirectory) {
		throw new Error(
			`Connect the ${source} source before importing its history.`,
		);
	}
	const files = await sourceFiles(source, sourceDirectory);
	const cursors: Record<string, number> = {};
	let bytes = 0;
	for (const filename of files) {
		cursors[filename] = 0;
		bytes += (await fs.stat(filename)).size;
		if (!Number.isSafeInteger(bytes)) {
			throw new Error(`${source} history size exceeds the supported limit.`);
		}
	}
	const localHealth = await healthSnapshot(paths);
	if (
		localHealth.kind === "unavailable" ||
		localHealth.health.historyCaughtUpAtMs !== null
	) {
		await saveHealth(
			{ ...localHealth.health, historyCaughtUpAtMs: null },
			paths,
		);
	}
	await saveState(
		{
			cursors,
			skipping: [],
			sourceDirectory,
			initialized: true,
		},
		paths,
	);
	return { files: files.length, bytes };
}

export async function historyImportSize(
	home: string,
	source: CollectorSource = "codex",
): Promise<Readonly<{ files: number; bytes: number }>> {
	const files = await sourceFiles(source, home);
	let bytes = 0;
	for (const filename of files) {
		bytes += (await fs.stat(filename)).size;
		if (!Number.isSafeInteger(bytes)) {
			throw new Error(`${source} history size exceeds the supported limit.`);
		}
	}
	return { files: files.length, bytes };
}

async function lastCompleteRecordOffset(
	filename: string,
	size: number,
): Promise<number> {
	if (size === 0) return 0;
	const handle = await fs.open(filename, "r");
	try {
		const finalByte = Buffer.alloc(1);
		await handle.read(finalByte, 0, 1, size - 1);
		if (finalByte[0] === 10) return size;
		let end = size;
		const minimum = Math.max(0, size - 32 * 1024 * 1024);
		while (end > minimum) {
			const start = Math.max(minimum, end - 64 * 1024);
			const buffer = Buffer.alloc(end - start);
			const result = await handle.read(buffer, 0, buffer.length, start);
			const newline = buffer.subarray(0, result.bytesRead).lastIndexOf(10);
			if (newline >= 0) return start + newline + 1;
			end = start;
		}
		if (size > 32 * 1024 * 1024) {
			throw new Error(`Could not find a safe rollout boundary in ${filename}.`);
		}
		return 0;
	} finally {
		await handle.close();
	}
}

async function rolloutFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (directory === undefined) continue;
		let entries;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				continue;
			throw new Error(`Could not scan Codex session directory ${directory}.`, {
				cause: error,
			});
		}
		for (const entry of entries) {
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) pending.push(filename);
			else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name))
				files.push(filename);
			if (files.length > 10_000)
				throw new Error("Codex session file count exceeds the scan limit.");
		}
	}
	return files.sort();
}

async function directoryEntries(directory: string) {
	try {
		return await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw new Error(`Could not scan Claude session directory ${directory}.`, {
			cause: error,
		});
	}
}

export async function claudeFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const project of await directoryEntries(root)) {
		if (!project.isDirectory()) continue;
		const projectDirectory = path.join(root, project.name);
		for (const entry of await directoryEntries(projectDirectory)) {
			const filename = path.join(projectDirectory, entry.name);
			if (
				entry.isFile() &&
				/^[^/]+\.jsonl$/.test(entry.name) &&
				!entry.name.includes(".orphaned-") &&
				!entry.name.includes(".superseded-")
			) {
				files.push(filename);
			} else if (entry.isDirectory()) {
				const subagents = path.join(filename, "subagents");
				for (const agent of await directoryEntries(subagents)) {
					if (agent.isFile() && /^agent-.+\.jsonl$/.test(agent.name))
						files.push(path.join(subagents, agent.name));
				}
			}
			if (files.length > 10_000)
				throw new Error("Claude session file count exceeds the scan limit.");
		}
	}
	return files.sort();
}

export type SourceFile = Readonly<{
	filename: string;
	size: number;
	session: boolean;
}>;

// Claude subagent transcripts belong to their parent session.
function isSessionFile(filename: string): boolean {
	return !filename.includes(`${path.sep}subagents${path.sep}`);
}

export async function countSavedSessions(
	source: CollectorSource,
	home: string,
): Promise<number> {
	return (await sourceFiles(source, home)).filter(isSessionFile).length;
}

// The most recently active sessions come first, so a first import shows
// current work before older history.
export async function sourceFilesNewestFirst(
	source: CollectorSource,
	home: string,
): Promise<readonly SourceFile[]> {
	const files = await sourceFiles(source, home);
	const listed: (SourceFile & Readonly<{ modifiedMs: number }>)[] = [];
	for (let start = 0; start < files.length; start += 64) {
		const batch = files.slice(start, start + 64);
		const stats = await Promise.all(batch.map((filename) => fs.stat(filename)));
		for (const [index, stat] of stats.entries()) {
			const filename = batch[index];
			if (filename === undefined) continue;
			listed.push({
				filename,
				size: stat.size,
				modifiedMs: stat.mtimeMs,
				session: isSessionFile(filename),
			});
		}
	}
	listed.sort(
		(left, right) =>
			right.modifiedMs - left.modifiedMs ||
			left.filename.localeCompare(right.filename),
	);
	return listed.map(({ filename, size, session }) => ({
		filename,
		size,
		session,
	}));
}

export function sourceFiles(
	source: CollectorSource,
	home: string,
): Promise<string[]> {
	const directory = path.resolve(home);
	if (source === "codex") return rolloutFiles(path.join(directory, "sessions"));
	if (source === "claude") return claudeFiles(path.join(directory, "projects"));
	if (source === "cursor") return cursorFiles(path.join(directory, "projects"));
	const unhandled: never = source;
	throw new Error(`Unsupported collector source: ${unhandled}`);
}

export async function cursorFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const project of await directoryEntries(root)) {
		if (!project.isDirectory()) continue;
		const transcripts = path.join(root, project.name, "agent-transcripts");
		for (const conversation of await directoryEntries(transcripts)) {
			if (!conversation.isDirectory()) continue;
			const filename = path.join(
				transcripts,
				conversation.name,
				`${conversation.name}.jsonl`,
			);
			if (
				(
					await fs.stat(filename).catch((error: unknown) => {
						if (
							error instanceof Error &&
							"code" in error &&
							error.code === "ENOENT"
						)
							return null;
						throw error;
					})
				)?.isFile()
			)
				files.push(filename);
			if (files.length > 10_000)
				throw new Error("Cursor session file count exceeds the scan limit.");
		}
	}
	return files.sort();
}
