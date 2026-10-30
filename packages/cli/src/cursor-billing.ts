import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as z from "zod";
import {
	cursorBillingRequestSchema,
	type CursorBillingRequest,
} from "iteration-trace-contracts";
import { type CollectorFetcher, collectorFetch } from "./collector-fetch.js";
import { cursorFiles, type CollectorConfig } from "./storage.js";

const CURSOR_USAGE_URL =
	"https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents";
const PAGE_SIZE = 500;
const MAX_PAGES = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_INTERVAL_MS = 7 * DAY_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const billingStateSchema = z
	.object({
		accountFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
		lastSyncedAtMs: z.number().int().nonnegative(),
		lastAuditAtMs: z.number().int().nonnegative(),
	})
	.strict();
type BillingState = z.infer<typeof billingStateSchema>;
type BillingSyncPlan = Readonly<{
	mode: "history" | "audit" | "recent";
	startDateMs: number;
	reconcileFromMs: number | null;
}>;

const usageEventSchema = z.object({
	conversationId: z.string().optional().nullable(),
	timestamp: z
		.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
		.pipe(z.number().int().nonnegative().safe()),
	kind: z.string(),
	usageBasedCosts: z.string().optional().nullable(),
	tokenUsage: z
		.object({
			inputTokens: z.number().int().nonnegative(),
			outputTokens: z.number().int().nonnegative(),
			cacheReadTokens: z.number().int().nonnegative(),
			cacheWriteTokens: z.number().int().nonnegative().optional(),
		})
		.optional()
		.nullable(),
});
const usagePageSchema = z.object({
	totalUsageEventsCount: z.number().int().nonnegative(),
	usageEventsDisplay: z.array(z.unknown()).max(PAGE_SIZE),
});
const emptyUsagePageSchema = z.object({}).strict();

function cursorAuthDatabase(): string | null {
	if (process.platform === "darwin")
		return path.join(
			os.homedir(),
			"Library/Application Support/Cursor/User/globalStorage/state.vscdb",
		);
	if (process.platform === "linux")
		return path.join(
			os.homedir(),
			".config/Cursor/User/globalStorage/state.vscdb",
		);
	if (process.platform === "win32")
		return path.join(
			process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
			"Cursor/User/globalStorage/state.vscdb",
		);
	return null;
}

async function readCursorAuth(): Promise<Readonly<{
	token: string;
	accountFingerprint: string;
}> | null> {
	const filename = cursorAuthDatabase();
	if (filename === null) return null;
	let database: DatabaseSync;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		database = new DatabaseSync(filename, { readOnly: true });
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === "SQLITE_CANTOPEN"
		)
			return null;
		throw new Error("Could not open Cursor's local account database.", {
			cause: error,
		});
	}
	try {
		const row = database
			.prepare("SELECT value FROM ItemTable WHERE key = ?")
			.get("cursorAuth/accessToken");
		const parsed = z.string().min(1).safeParse(row?.value);
		if (!parsed.success) return null;
		const email = z
			.string()
			.email()
			.safeParse(
				database
					.prepare("SELECT value FROM ItemTable WHERE key = ?")
					.get("cursorAuth/cachedEmail")?.value,
			);
		const identity = email.success
			? `email:${email.data.toLowerCase()}`
			: `token:${parsed.data}`;
		return {
			token: parsed.data,
			accountFingerprint: createHash("sha256").update(identity).digest("hex"),
		};
	} catch (error) {
		throw new Error("Could not read Cursor's local account token.", {
			cause: error,
		});
	} finally {
		database.close();
	}
}

async function loadBillingState(
	filename: string,
): Promise<BillingState | null> {
	let contents: string;
	try {
		contents = await fs.readFile(filename, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw new Error("Could not read Cursor billing sync state.", {
			cause: error,
		});
	}
	try {
		return billingStateSchema.parse(JSON.parse(contents));
	} catch (error) {
		throw new Error("Cursor billing sync state is invalid.", { cause: error });
	}
}

async function saveBillingState(
	filename: string,
	state: BillingState,
): Promise<void> {
	const temporary = `${filename}.${process.pid}.tmp`;
	const handle = await fs.open(temporary, "w", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, filename);
}

export function planCursorBillingSync(
	state: BillingState | null,
	accountFingerprint: string,
	nowMs: number,
): BillingSyncPlan {
	if (state === null || state.accountFingerprint !== accountFingerprint)
		return { mode: "history", startDateMs: 0, reconcileFromMs: null };
	const audit = nowMs - state.lastAuditAtMs >= AUDIT_INTERVAL_MS;
	const fetchDays = audit ? 36 : 8;
	const reconcileDays = audit ? 35 : 7;
	return {
		mode: audit ? "audit" : "recent",
		startDateMs: Math.max(
			0,
			Math.min(state.lastSyncedAtMs - DAY_MS, nowMs - fetchDays * DAY_MS),
		),
		reconcileFromMs: Math.max(
			0,
			Math.min(state.lastSyncedAtMs, nowMs - reconcileDays * DAY_MS),
		),
	};
}

export function cursorConversationIds(
	filenames: readonly string[],
): ReadonlySet<string> {
	return new Set(
		filenames
			.map((filename) => path.basename(filename, ".jsonl"))
			.filter((id) => UUID.test(id)),
	);
}

function billingKind(
	kind: string,
): CursorBillingRequest["events"][number]["kind"] {
	switch (kind) {
		case "USAGE_EVENT_KIND_INCLUDED_IN_PRO":
		case "USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS":
			return "included";
		case "USAGE_EVENT_KIND_USAGE_BASED":
			return "paid";
		case "USAGE_EVENT_KIND_USER_API_KEY":
			return "byok";
		case "USAGE_EVENT_KIND_ERRORED_NOT_CHARGED":
		case "USAGE_EVENT_KIND_ABORTED_NOT_CHARGED":
			return "not_charged";
		default:
			return "unknown";
	}
}

function paidUsd(value: string | null | undefined): number | null {
	if (value === null || value === undefined || value === "-") return null;
	if (!/^\$\d+(?:\.\d{1,6})?$/.test(value))
		throw new Error("Cursor returned an invalid usage-based charge.");
	return Number(value.slice(1));
}

export function normalizeCursorUsageEvent(
	value: unknown,
	localConversations: ReadonlySet<string>,
): Readonly<{
	conversationId: string;
	event: CursorBillingRequest["events"][number];
}> | null {
	const identity = z
		.object({ conversationId: z.string().optional().nullable() })
		.safeParse(value);
	if (!identity.success)
		throw new Error("Cursor returned an invalid usage event.");
	const conversationId = identity.data.conversationId;
	if (
		conversationId === null ||
		conversationId === undefined ||
		!localConversations.has(conversationId)
	)
		return null;
	const parsed = usageEventSchema.safeParse(value);
	if (!parsed.success)
		throw new Error(
			"Cursor returned an invalid usage event for a local transcript.",
		);
	const row = parsed.data;
	const usage = row.tokenUsage;
	const kind = billingKind(row.kind);
	return {
		conversationId,
		event: {
			timestamp: row.timestamp,
			kind,
			inputTokens: usage?.inputTokens ?? null,
			outputTokens: usage?.outputTokens ?? null,
			cacheReadTokens: usage?.cacheReadTokens ?? null,
			cacheWriteTokens:
				usage?.cacheWriteTokens ??
				(usage === null || usage === undefined ? null : 0),
			paidUsd: kind === "paid" ? paidUsd(row.usageBasedCosts) : null,
		},
	};
}

export async function syncCursorBilling(
	config: CollectorConfig & Readonly<{ cursorHome: string }>,
	fetcher: CollectorFetcher = collectorFetch,
	signal?: AbortSignal,
): Promise<
	Readonly<{
		sessions: number;
		matched: number;
		skipped: boolean;
		mode: BillingSyncPlan["mode"] | null;
	}>
> {
	const auth = await readCursorAuth();
	if (auth === null)
		return { sessions: 0, matched: 0, skipped: true, mode: null };
	const localConversations = cursorConversationIds(
		await cursorFiles(path.join(config.cursorHome, "projects")),
	);
	if (localConversations.size === 0)
		return { sessions: 0, matched: 0, skipped: true, mode: null };
	const stateFile = path.join(config.dataDirectory, "cursor-billing-sync.json");
	const priorState = await loadBillingState(stateFile);
	const nowMs = Date.now();
	const plan = planCursorBillingSync(
		priorState,
		auth.accountFingerprint,
		nowMs,
	);
	const byConversation = new Map<
		string,
		CursorBillingRequest["events"][number][]
	>();
	const readUsagePages = async () => {
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			signal?.throwIfAborted();
			const response = await fetch(CURSOR_USAGE_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${auth.token}`,
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
				},
				body: JSON.stringify({
					page,
					pageSize: PAGE_SIZE,
					startDate: String(plan.startDateMs),
				}),
				signal: AbortSignal.any([
					AbortSignal.timeout(20_000),
					...(signal ? [signal] : []),
				]),
			});
			if (!response.ok)
				throw new Error(
					`Cursor billing lookup failed with HTTP ${response.status}.`,
				);
			const rawPage: unknown = await response.json();
			if (emptyUsagePageSchema.safeParse(rawPage).success) {
				if (page !== 1)
					throw new Error(
						"Cursor billing history ended before its reported count.",
					);
				break;
			}
			const decoded = usagePageSchema.safeParse(rawPage);
			if (!decoded.success)
				throw new Error("Cursor returned an invalid billing page.");
			for (const value of decoded.data.usageEventsDisplay) {
				const normalized = normalizeCursorUsageEvent(value, localConversations);
				if (normalized === null) continue;
				const events = byConversation.get(normalized.conversationId) ?? [];
				events.push(normalized.event);
				if (events.length > 5000)
					throw new Error(
						"Cursor conversation exceeds the billing sync limit.",
					);
				byConversation.set(normalized.conversationId, events);
			}
			if (page * PAGE_SIZE >= decoded.data.totalUsageEventsCount) break;
			if (page === MAX_PAGES)
				throw new Error(
					"Cursor account exceeds the billing history page limit.",
				);
			if (decoded.data.usageEventsDisplay.length === 0)
				throw new Error(
					"Cursor billing history ended before its reported count.",
				);
		}
	};
	await readUsagePages();
	const endpoint = new URL(config.endpoint);
	endpoint.pathname = "/api/traces/cursor-billing";
	let matched = 0;
	for (const [conversationId, events] of byConversation) {
		signal?.throwIfAborted();
		const request = cursorBillingRequestSchema.parse({
			conversationId,
			reconcileFromMs: plan.reconcileFromMs,
			events,
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
				`Cursor billing sync failed with HTTP ${response.status}.`,
			);
		const result = z
			.object({ matched: z.number().int().nonnegative() })
			.safeParse(await response.json());
		if (!result.success)
			throw new Error("Iteration returned an invalid billing sync result.");
		matched += result.data.matched;
	}
	await saveBillingState(stateFile, {
		accountFingerprint: auth.accountFingerprint,
		lastSyncedAtMs: nowMs,
		lastAuditAtMs: plan.mode === "recent" ? priorState!.lastAuditAtMs : nowMs,
	});
	return {
		sessions: byConversation.size,
		matched,
		skipped: false,
		mode: plan.mode,
	};
}
