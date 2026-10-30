import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	codexCreditSign,
	codexBillingRequestSchema,
	type CodexBillingRequest,
} from "iteration-trace-contracts";
import * as z from "zod";
import { type CollectorFetcher, collectorFetch } from "./collector-fetch.js";
import { sourceFiles, type CollectorConfig } from "./storage.js";

const TASK_USAGE_URL =
	"https://chatgpt.com/backend-api/wham/usage/thread_usage/query_v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const TASK_BATCH_SIZE = 50;
const MAX_HEADER_BYTES = 3 * 1024 * 1024;
const stateSchema = z.object({
	accountFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	lastSyncedAtMs: z.number().int().nonnegative(),
	lastAuditAtMs: z.number().int().nonnegative(),
	unavailableThreadIds: z.array(z.uuid()),
});
const authSchema = z.object({
	auth_mode: z.string().optional(),
	tokens: z
		.object({
			access_token: z.string().min(1),
			account_id: z.string().min(1),
		})
		.optional(),
});
const taskUsageSchema = z.object({
	threads: z
		.array(
			z.object({
				thread_id: z.uuid(),
				data_status: z.enum(["available", "partial", "unavailable"]),
				usage_source: z.string(),
				balance_usage_credits: z.string().nullable().optional(),
			}),
		)
		.max(TASK_BATCH_SIZE),
});
const sessionMetaSchema = z.object({
	type: z.literal("session_meta"),
	payload: z.object({
		id: z.uuid(),
		timestamp: z.string().optional(),
		creator_account_id: z.string().nullable().optional(),
		model_provider: z.string().nullable().optional(),
		parent_thread_id: z.string().nullable().optional(),
		source: z.unknown().optional(),
	}),
});
const subagentSourceSchema = z.object({
	subagent: z
		.object({
			thread_spawn: z.object({ parent_thread_id: z.string() }).optional(),
		})
		.optional(),
});
const syncResultSchema = z.object({ matched: z.number().int().nonnegative() });

type LocalThread = Readonly<{
	threadId: string;
	parentThreadId: string | null;
	createdAt: string | null;
	accountId: string | null;
	modelProvider: string | null;
	mtimeMs: number;
}>;
type LocalTask = Readonly<{
	threadId: string;
	createdAt: string | null;
	descendantThreadIds: readonly string[];
	mtimeMs: number;
}>;
type BillingState = z.infer<typeof stateSchema>;

function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function readAuth(codexHome: string): Promise<
	Readonly<{
		accessToken: string | null;
		accountId: string | null;
		accountFingerprint: string;
	}>
> {
	let contents: string;
	try {
		contents = await fs.readFile(path.join(codexHome, "auth.json"), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return {
				accessToken: null,
				accountId: null,
				accountFingerprint: fingerprint(
					"codex-local-auth-logs:no-chatgpt-token",
				),
			};
		throw new Error("Could not read Codex authentication.", { cause: error });
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error("Codex authentication is not valid JSON.", {
			cause: error,
		});
	}
	const parsed = authSchema.safeParse(decoded);
	if (!parsed.success)
		throw new Error("Codex authentication has an unexpected shape.");
	const accountId = parsed.data.tokens?.account_id ?? null;
	return {
		accessToken:
			parsed.data.auth_mode === "chatgpt"
				? (parsed.data.tokens?.access_token ?? null)
				: null,
		accountId,
		accountFingerprint: fingerprint(
			`${accountId ?? "codex-local-auth-logs"}:${parsed.data.auth_mode === "chatgpt" && parsed.data.tokens?.access_token ? "chatgpt" : "no-chatgpt-token"}`,
		),
	};
}

async function readState(filename: string): Promise<BillingState | null> {
	let contents: string;
	try {
		contents = await fs.readFile(filename, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw new Error("Could not read Codex billing sync state.", {
			cause: error,
		});
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error("Codex billing sync state is not valid JSON.", {
			cause: error,
		});
	}
	const parsed = stateSchema.safeParse(decoded);
	if (!parsed.success) throw new Error("Codex billing sync state is invalid.");
	return parsed.data;
}

async function saveState(filename: string, state: BillingState): Promise<void> {
	const temporary = `${filename}.${process.pid}.tmp`;
	const handle = await fs.open(temporary, "w", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(state)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, filename);
}

async function localThread(filename: string): Promise<LocalThread | null> {
	const stat = await fs.stat(filename);
	const handle = await fs.open(filename, "r");
	let header: Buffer | null = null;
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const chunks: Buffer[] = [];
		let offset = 0;
		while (offset < Math.min(stat.size, MAX_HEADER_BYTES)) {
			const read = await handle.read(
				buffer,
				0,
				Math.min(buffer.length, MAX_HEADER_BYTES - offset),
				offset,
			);
			if (read.bytesRead === 0) break;
			const newline = buffer.subarray(0, read.bytesRead).indexOf(10);
			if (newline >= 0) {
				chunks.push(Buffer.from(buffer.subarray(0, newline)));
				header = Buffer.concat(chunks);
				break;
			}
			chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
			offset += read.bytesRead;
		}
	} finally {
		await handle.close();
	}
	if (header === null) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(header.toString("utf8"));
	} catch {
		return null;
	}
	const record = sessionMetaSchema.safeParse(raw);
	if (!record.success) return null;
	const payload = record.data.payload;
	if (!filename.endsWith(`${payload.id}.jsonl`)) return null;
	const source = subagentSourceSchema.safeParse(payload.source);
	const parentThreadId =
		payload.parent_thread_id ??
		(source.success
			? source.data.subagent?.thread_spawn?.parent_thread_id
			: null) ??
		null;
	if (parentThreadId !== null && !UUID.test(parentThreadId)) return null;
	return {
		threadId: payload.id,
		parentThreadId,
		createdAt:
			payload.timestamp && !Number.isNaN(Date.parse(payload.timestamp))
				? new Date(payload.timestamp).toISOString()
				: null,
		accountId: payload.creator_account_id ?? null,
		modelProvider: payload.model_provider ?? null,
		mtimeMs: stat.mtimeMs,
	};
}

export function groupCodexTasks(
	threads: readonly LocalThread[],
	accountId: string | null,
): readonly LocalTask[] {
	const byId = new Map(
		threads
			.filter(
				(thread) => thread.accountId === null || thread.accountId === accountId,
			)
			.map((thread) => [thread.threadId, thread]),
	);
	const tasks = new Map<
		string,
		{
			threadId: string;
			createdAt: string | null;
			descendantThreadIds: string[];
			mtimeMs: number;
		}
	>();
	for (const thread of byId.values()) {
		if (thread.parentThreadId === null)
			tasks.set(thread.threadId, {
				threadId: thread.threadId,
				createdAt: thread.createdAt,
				descendantThreadIds: [],
				mtimeMs: thread.mtimeMs,
			});
	}
	for (const thread of byId.values()) {
		if (thread.parentThreadId === null) continue;
		let ancestor = thread.parentThreadId;
		const seen = new Set([thread.threadId]);
		while (ancestor !== null && !seen.has(ancestor)) {
			seen.add(ancestor);
			const parent = byId.get(ancestor);
			if (parent === undefined) break;
			if (parent.parentThreadId === null) {
				const task = tasks.get(parent.threadId);
				if (task !== undefined) {
					task.descendantThreadIds.push(thread.threadId);
					task.mtimeMs = Math.max(task.mtimeMs, thread.mtimeMs);
				}
				break;
			}
			ancestor = parent.parentThreadId;
		}
	}
	return [...tasks.values()].map((task) => ({
		...task,
		descendantThreadIds: task.descendantThreadIds.sort(),
	}));
}

export function parseCodexAuthLog(
	threadId: string | null,
	body: string | null,
): CodexBillingRequest["authTurns"][number] | null {
	if (threadId === null || !UUID.test(threadId) || body === null) return null;
	const turn = /try_run_sampling_request\{turn_id=([0-9a-f-]{36})\b/i.exec(
		body,
	);
	const auth = /\bauth_mode=Some\(([^)]+)\)/.exec(body);
	if (turn === null || auth === null || !UUID.test(turn[1]!)) return null;
	const mode =
		auth[1] === "Chatgpt"
			? "chatgpt"
			: auth[1] === "ApiKey" ||
					auth[1] === "BedrockApiKey" ||
					auth[1] === "BedrockAccessKeys"
				? "api_key"
				: "conflicting";
	return { threadId, turnId: turn[1]!, mode };
}

async function localAuthTurns(
	codexHome: string,
	modelProviders: ReadonlyMap<string, string | null>,
): Promise<CodexBillingRequest["authTurns"]> {
	const filename = path.join(codexHome, "logs_2.sqlite");
	try {
		await fs.access(filename);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw new Error("Could not access Codex's local logs.", { cause: error });
	}
	const { DatabaseSync } = await import("node:sqlite");
	let database: DatabaseSync;
	try {
		database = new DatabaseSync(filename, { readOnly: true });
	} catch (error) {
		throw new Error("Could not open Codex's local logs.", { cause: error });
	}
	const turns = new Map<string, CodexBillingRequest["authTurns"][number]>();
	const logRowSchema = z.object({
		thread_id: z.string().nullable(),
		feedback_log_body: z.string().nullable(),
	});
	try {
		const rows = database
			.prepare(
				"SELECT thread_id, feedback_log_body FROM logs WHERE target = 'feedback_tags' AND feedback_log_body LIKE '%auth_mode=Some(%'",
			)
			.iterate();
		for (const raw of rows) {
			const row = logRowSchema.safeParse(raw);
			if (!row.success)
				throw new Error("Codex's local log row has an invalid shape.");
			if (
				row.data.thread_id === null ||
				!modelProviders.has(row.data.thread_id)
			)
				continue;
			const parsed = parseCodexAuthLog(
				row.data.thread_id,
				row.data.feedback_log_body,
			);
			if (parsed === null) continue;
			const mode =
				parsed.mode === "chatgpt" &&
				modelProviders.get(parsed.threadId) !== "openai"
					? "conflicting"
					: parsed.mode;
			const key = `${parsed.threadId}:${parsed.turnId}`;
			const prior = turns.get(key);
			turns.set(key, {
				...parsed,
				mode: prior === undefined || prior.mode === mode ? mode : "conflicting",
			});
		}
	} finally {
		database.close();
	}
	return [...turns.values()];
}

async function queryTaskUsage(
	tasks: readonly LocalTask[],
	accessToken: string,
	accountId: string,
	signal?: AbortSignal,
): Promise<Map<string, CodexBillingRequest["tasks"][number]>> {
	const response = await fetch(TASK_USAGE_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"ChatGPT-Account-Id": accountId,
			"Content-Type": "application/json",
			"User-Agent": "codex-cli",
		},
		body: JSON.stringify({
			threads: tasks.map((task) => ({
				thread_id: task.threadId,
				created_at: task.createdAt,
				descendant_thread_ids: task.descendantThreadIds,
			})),
		}),
		signal: AbortSignal.any([
			AbortSignal.timeout(20_000),
			...(signal ? [signal] : []),
		]),
	});
	if (!response.ok)
		throw new Error(
			`Codex task usage lookup failed with HTTP ${response.status}.`,
		);
	const parsed = taskUsageSchema.safeParse(await response.json());
	if (!parsed.success) throw new Error("Codex returned invalid task usage.");
	const requested = new Set(tasks.map((task) => task.threadId));
	const byId = new Map(tasks.map((task) => [task.threadId, task]));
	const result = new Map<string, CodexBillingRequest["tasks"][number]>();
	for (const row of parsed.data.threads) {
		if (!requested.has(row.thread_id) || result.has(row.thread_id))
			throw new Error("Codex returned an unexpected task usage ID.");
		const task = byId.get(row.thread_id)!;
		result.set(row.thread_id, {
			threadId: row.thread_id,
			createdAt: task.createdAt,
			descendantThreadIds: [...task.descendantThreadIds],
			dataStatus: row.data_status,
			usageSource: row.usage_source,
			balanceUsageCredits: row.balance_usage_credits ?? null,
		});
	}
	return result;
}

export async function syncCodexBilling(
	config: CollectorConfig & Readonly<{ codexHome: string }>,
	fetcher: CollectorFetcher = collectorFetch,
	signal?: AbortSignal,
): Promise<
	Readonly<{
		tasks: number;
		included: number;
		creditTasks: number;
		apiTurns: number;
		skipped: boolean;
	}>
> {
	const auth = await readAuth(config.codexHome);
	const stateFile = path.join(config.dataDirectory, "codex-billing-sync.json");
	const prior = await readState(stateFile);
	const nowMs = Date.now();
	const history =
		prior === null || prior.accountFingerprint !== auth.accountFingerprint;
	const audit = !history && nowMs - prior.lastAuditAtMs >= 7 * DAY_MS;
	const cutoff = history
		? 0
		: Math.min(
				prior.lastSyncedAtMs - DAY_MS,
				nowMs - (audit ? 35 : 7) * DAY_MS,
			);
	const filenames = await sourceFiles("codex", config.codexHome);
	const threads: LocalThread[] = [];
	const readLocalThreads = async () => {
		for (const filename of filenames) {
			signal?.throwIfAborted();
			const thread = await localThread(filename);
			if (thread !== null) threads.push(thread);
		}
	};
	await readLocalThreads();
	const allTasks = groupCodexTasks(threads, auth.accountId);
	const retryIds = new Set(audit ? (prior?.unavailableThreadIds ?? []) : []);
	const selected = allTasks.filter(
		(task) => task.mtimeMs >= cutoff || retryIds.has(task.threadId),
	);
	if (selected.length === 0)
		return {
			tasks: 0,
			included: 0,
			creditTasks: 0,
			apiTurns: 0,
			skipped: false,
		};
	const selectedIds = new Set(
		selected.flatMap((task) => [task.threadId, ...task.descendantThreadIds]),
	);
	const modelProviders = new Map(
		threads
			.filter((thread) => selectedIds.has(thread.threadId))
			.map((thread) => [thread.threadId, thread.modelProvider]),
	);
	const authTurns = await localAuthTurns(config.codexHome, modelProviders);
	const byThread = new Map<string, typeof authTurns>();
	for (const turn of authTurns) {
		const turns = byThread.get(turn.threadId) ?? [];
		turns.push(turn);
		byThread.set(turn.threadId, turns);
	}
	const localTaskIds = new Set(allTasks.map((task) => task.threadId));
	const unavailable = new Set(
		history
			? []
			: (prior?.unavailableThreadIds ?? []).filter((id) =>
					localTaskIds.has(id),
				),
	);
	let included = 0;
	let creditTasks = 0;
	let apiTurns = 0;
	const endpoint = new URL(config.endpoint);
	endpoint.pathname = "/api/traces/codex-billing";
	const createBatches = () => {
		const batches: LocalTask[][] = [];
		let current: LocalTask[] = [];
		let currentIds = 0;
		let currentTurns = 0;
		for (const task of selected) {
			const size = 1 + task.descendantThreadIds.length;
			const turns = [task.threadId, ...task.descendantThreadIds].reduce(
				(total, threadId) => total + (byThread.get(threadId)?.length ?? 0),
				0,
			);
			if (size > 1000)
				throw new Error("Codex task exceeds the billing thread limit.");
			if (
				current.length >= TASK_BATCH_SIZE ||
				currentIds + size > 1000 ||
				currentTurns + turns > 5000
			) {
				if (current.length > 0) batches.push(current);
				current = [];
				currentIds = 0;
				currentTurns = 0;
			}
			current.push(task);
			currentIds += size;
			currentTurns += turns;
			if (turns > 5000) {
				batches.push(current);
				current = [];
				currentIds = 0;
				currentTurns = 0;
			}
		}
		if (current.length > 0) batches.push(current);
		return batches;
	};
	const batches = createBatches();
	const syncBatch = async (batch: LocalTask[]) => {
		signal?.throwIfAborted();
		const responseTasks =
			auth.accessToken === null || auth.accountId === null
				? new Map<string, CodexBillingRequest["tasks"][number]>()
				: await queryTaskUsage(batch, auth.accessToken, auth.accountId, signal);
		const tasks = batch.map((task) => {
			const response = responseTasks.get(task.threadId);
			return (
				response ?? {
					threadId: task.threadId,
					createdAt: task.createdAt,
					descendantThreadIds: [...task.descendantThreadIds],
					dataStatus:
						auth.accessToken === null || auth.accountId === null
							? ("not_queried" as const)
							: ("unavailable" as const),
					usageSource: "",
					balanceUsageCredits: null,
				}
			);
		});
		const batchTurns = batch.flatMap((task) =>
			[task.threadId, ...task.descendantThreadIds].flatMap(
				(threadId) => byThread.get(threadId) ?? [],
			),
		);
		let serverIncomplete = false;
		for (
			let offset = 0;
			offset < Math.max(1, batchTurns.length);
			offset += 5000
		) {
			const request = codexBillingRequestSchema.parse({
				accountFingerprint: auth.accountFingerprint,
				reconcile: offset === 0,
				tasks,
				authTurns: batchTurns.slice(offset, offset + 5000),
			});
			const response = await fetcher(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(request),
				signal: AbortSignal.any([
					AbortSignal.timeout(90_000),
					...(signal ? [signal] : []),
				]),
			});
			if (!response.ok)
				throw new Error(
					`Codex billing sync failed with HTTP ${response.status}.`,
				);
			const result = syncResultSchema.safeParse(await response.json());
			if (!result.success || result.data.matched > tasks.length)
				throw new Error("Iteration returned an invalid Codex billing result.");
			if (result.data.matched < tasks.length) serverIncomplete = true;
		}
		const reconcileTask = (task: CodexBillingRequest["tasks"][number]) => {
			if (
				task.dataStatus === "available" &&
				task.balanceUsageCredits !== null &&
				(task.usageSource === "included_plan" ||
					task.usageSource === "plan_and_credits")
			)
				unavailable.delete(task.threadId);
			else if (task.dataStatus !== "not_queried")
				unavailable.add(task.threadId);
			if (serverIncomplete) unavailable.add(task.threadId);
			if (
				task.dataStatus === "available" &&
				task.balanceUsageCredits !== null &&
				(task.usageSource === "included_plan" ||
					task.usageSource === "plan_and_credits")
			) {
				if (
					codexCreditSign(task.balanceUsageCredits) === 0 &&
					task.usageSource === "included_plan"
				)
					included += 1;
				else if (codexCreditSign(task.balanceUsageCredits) > 0)
					creditTasks += 1;
			}
		};
		for (const task of tasks) reconcileTask(task);
		apiTurns += batchTurns.filter((turn) => turn.mode === "api_key").length;
	};
	for (const batch of batches) await syncBatch(batch);
	await saveState(stateFile, {
		accountFingerprint: auth.accountFingerprint,
		lastSyncedAtMs: nowMs,
		lastAuditAtMs: history || audit ? nowMs : prior!.lastAuditAtMs,
		unavailableThreadIds: [...unavailable],
	});
	return {
		tasks: selected.length,
		included,
		creditTasks,
		apiTurns,
		skipped: false,
	};
}
