import { promises as fs } from "node:fs";
import path from "node:path";
import {
	vaultAccountReference,
	type VaultCapturePolicy,
	type VaultCaptureAuthorization,
	type JsonValue,
} from "iteration-trace-contracts";
import * as z from "zod";
import { ensurePrivateDirectory } from "./private-storage.js";

export const CLAUDE_ACCOUNT_VERSION = "2.1.282";
const MAX_CLAUDE_EVIDENCE = 20_000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const EVIDENCE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const identifier = z.string().min(1).max(255);
const evidenceSchema = z
	.object({
		event: z.enum([
			"user_prompt",
			"api_request",
			"assistant_response",
			"tool_result",
			"native_tool",
		]),
		sessionId: z.uuid(),
		promptId: z.uuid().nullable(),
		messageId: z.uuid().nullable(),
		requestId: identifier.nullable(),
		toolId: identifier.nullable(),
		accountId: identifier.nullable(),
		organizationId: identifier.nullable(),
		receivedAt: z.number().int().nonnegative(),
	})
	.strict();
const ledgerSchema = z
	.object({
		version: z.literal(1),
		generation: z.number().int().nonnegative(),
		records: z.array(evidenceSchema).max(MAX_CLAUDE_EVIDENCE),
	})
	.strict();

export type ClaudeAccountEvidence = z.infer<typeof evidenceSchema>;
export type ClaudeAccountLedger = z.infer<typeof ledgerSchema>;

export async function loadClaudeAccountLedger(
	directory: string,
): Promise<ClaudeAccountLedger> {
	const filename = path.join(directory, "claude-account-ledger.json");
	let text: string;
	try {
		if ((await fs.stat(filename)).size > MAX_LEDGER_BYTES)
			throw new Error("Claude metadata ledger exceeds its 8 MiB capacity.");
		text = await fs.readFile(filename, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { version: 1, generation: 0, records: [] };
		throw error;
	}
	const parsed = ledgerSchema.safeParse(JSON.parse(text));
	if (!parsed.success)
		throw new Error(
			"Claude metadata ledger is invalid; account capture is blocked.",
		);
	return {
		...parsed.data,
		records: parsed.data.records.filter(
			(record) => record.receivedAt >= Date.now() - EVIDENCE_LIFETIME_MS,
		),
	};
}

const ledgerWrites = new Map<string, Promise<ClaudeAccountLedger>>();

export async function saveClaudeAccountEvidence(
	directory: string,
	incoming: readonly ClaudeAccountEvidence[],
): Promise<ClaudeAccountLedger> {
	const persist = () => persistClaudeAccountEvidence(directory, incoming);
	const previous = ledgerWrites.get(directory);
	// The receiver and scanner share this ledger. A failed predecessor is still
	// reported to its caller, but must not poison subsequent independent writes.
	const operation = previous ? previous.then(persist, persist) : persist();
	ledgerWrites.set(directory, operation);
	try {
		return await operation;
	} finally {
		if (ledgerWrites.get(directory) === operation)
			ledgerWrites.delete(directory);
	}
}

async function persistClaudeAccountEvidence(
	directory: string,
	incoming: readonly ClaudeAccountEvidence[],
): Promise<ClaudeAccountLedger> {
	const current = await loadClaudeAccountLedger(directory);
	const records = new Map(
		current.records.map((record) => [evidenceKey(record), record]),
	);
	const previousSize = records.size;
	for (const record of incoming)
		records.set(evidenceKey(record), evidenceSchema.parse(record));
	if (records.size > MAX_CLAUDE_EVIDENCE)
		throw new Error(
			"Claude metadata ledger is full (20,000 records); account capture is paused until evidence expires or storage is explicitly cleared.",
		);
	const ledger: ClaudeAccountLedger = {
		version: 1,
		generation: current.generation + Number(records.size !== previousSize),
		records: [...records.values()],
	};
	const text = `${JSON.stringify(ledger)}\n`;
	if (Buffer.byteLength(text) > MAX_LEDGER_BYTES)
		throw new Error("Claude metadata ledger exceeds its 8 MiB capacity.");
	await ensurePrivateDirectory(directory);
	const filename = path.join(directory, "claude-account-ledger.json");
	const temporary = `${filename}.${process.pid}.tmp`;
	try {
		const handle = await fs.open(temporary, "w", 0o600);
		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, filename);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
	return ledger;
}

function evidenceKey(record: ClaudeAccountEvidence): string {
	return JSON.stringify([
		record.event,
		record.sessionId,
		record.promptId,
		record.messageId,
		record.requestId,
		record.toolId,
		record.accountId,
		record.organizationId,
	]);
}

const nativeIdentitySchema = z.object({
	type: z.enum(["user", "assistant"]),
	sessionId: z.uuid(),
	uuid: z.uuid(),
	requestId: identifier.optional(),
	message: z.object({
		content: z.union([
			z.string(),
			z.array(
				z.object({
					type: z.string(),
					id: identifier.optional(),
					tool_use_id: identifier.optional(),
				}),
			),
		]),
	}),
});

export function claudeCaptureIdentity(native: unknown): JsonValue {
	const record = nativeIdentitySchema.parse(native);
	return {
		type: record.type,
		sessionId: record.sessionId,
		uuid: record.uuid,
		...(record.requestId === undefined ? {} : { requestId: record.requestId }),
		message: {
			content: Array.isArray(record.message.content)
				? record.message.content.map((block) => ({
						type: block.type,
						...(block.tool_use_id === undefined
							? {}
							: { tool_use_id: block.tool_use_id }),
					}))
				: "",
		},
	};
}

export class ClaudeAccountIndex {
	readonly generation: number;
	private readonly messages = new Map<string, ClaudeAccountEvidence[]>();
	private readonly prompts = new Map<string, ClaudeAccountEvidence[]>();
	private readonly requests = new Map<string, ClaudeAccountEvidence[]>();
	private readonly tools = new Map<string, ClaudeAccountEvidence[]>();
	private readonly userPrompts = new Map<string, ClaudeAccountEvidence[]>();
	private readonly nativeTools: ClaudeAccountEvidence[] = [];
	readonly accounts: ReadonlyArray<{
		source: "claude";
		accountId: string;
		organizationId: string | null;
	}>;

	constructor(ledger: ClaudeAccountLedger) {
		this.generation = ledger.generation;
		const accounts = new Map<
			string,
			{ source: "claude"; accountId: string; organizationId: string | null }
		>();
		for (const record of ledger.records) {
			if (record.event === "user_prompt") {
				this.add(this.userPrompts, record.sessionId, record.messageId, record);
				continue;
			}
			if (record.event === "tool_result" || record.event === "native_tool") {
				this.add(this.tools, record.sessionId, record.toolId, record);
				continue;
			}
			if (record.accountId === null) continue;
			this.add(this.messages, record.sessionId, record.messageId, record);
			this.add(this.prompts, record.sessionId, record.promptId, record);
			this.add(this.requests, record.sessionId, record.requestId, record);
			const account = {
				source: "claude" as const,
				accountId: record.accountId,
				organizationId: record.organizationId,
			};
			accounts.set(vaultAccountReference(account), account);
		}
		this.accounts = [...accounts.values()];
	}

	observeAuthorizedNative(native: unknown): void {
		const parsed = nativeIdentitySchema.safeParse(native);
		if (!parsed.success) return;
		const record = parsed.data;
		if (
			record.type !== "assistant" ||
			!record.requestId ||
			!Array.isArray(record.message.content) ||
			this.get(this.requests, record.sessionId, record.requestId).length === 0
		)
			return;
		// Claude 2.1.282 tool_result exports lack request_id. The native assistant
		// binds each exact tool-use ID to its evidenced API request instead.
		for (const block of record.message.content) {
			if (block.type !== "tool_use" || !block.id) continue;
			if (
				this.get(this.tools, record.sessionId, block.id).some(
					(row) => row.requestId === record.requestId,
				)
			)
				continue;
			const evidence: ClaudeAccountEvidence = {
				event: "native_tool",
				sessionId: record.sessionId,
				messageId: record.uuid,
				requestId: record.requestId,
				toolId: block.id,
				promptId: null,
				accountId: null,
				organizationId: null,
				receivedAt: Date.now(),
			};
			this.add(this.tools, record.sessionId, block.id, evidence);
			this.nativeTools.push(evidence);
		}
	}

	async persistNativeTools(directory: string): Promise<void> {
		if (this.nativeTools.length === 0) return;
		await saveClaudeAccountEvidence(directory, this.nativeTools);
		this.nativeTools.length = 0;
	}

	private key(session: string, id: string): string {
		return JSON.stringify([session, id]);
	}
	private add(
		map: Map<string, ClaudeAccountEvidence[]>,
		session: string,
		id: string | null,
		record: ClaudeAccountEvidence,
	): void {
		if (id === null) return;
		const key = this.key(session, id);
		const rows = map.get(key) ?? [];
		rows.push(record);
		map.set(key, rows);
	}
	private get(
		map: Map<string, ClaudeAccountEvidence[]>,
		session: string,
		id: string | null | undefined,
	): readonly ClaudeAccountEvidence[] {
		return id ? (map.get(this.key(session, id)) ?? []) : [];
	}

	authorize(
		policy: VaultCapturePolicy,
		native: unknown,
	): VaultCaptureAuthorization | null {
		const parsed = nativeIdentitySchema.safeParse(native);
		if (!parsed.success) return null;
		const record = parsed.data;
		const candidates =
			record.type === "assistant"
				? [
						...this.get(this.messages, record.sessionId, record.uuid),
						...this.get(this.requests, record.sessionId, record.requestId),
					]
				: this.userEvidence(record);
		const references = new Set(
			candidates
				.filter((row) => row.accountId !== null)
				.map((row) =>
					vaultAccountReference({
						source: "claude",
						accountId: row.accountId!,
						organizationId: row.organizationId,
					}),
				),
		);
		if (references.size !== 1) return null;
		const reference = [...references][0]!;
		return policy.accounts.some(
			(account) => vaultAccountReference(account) === reference,
		)
			? { revision: policy.revision, basis: "account", reference }
			: null;
	}

	private userEvidence(
		record: z.infer<typeof nativeIdentitySchema>,
	): ClaudeAccountEvidence[] {
		const content = record.message.content;
		if (
			Array.isArray(content) &&
			content.length > 0 &&
			content.every(
				(block) => block.type === "tool_result" && block.tool_use_id,
			)
		) {
			const groups = content.map((block) =>
				this.get(this.tools, record.sessionId, block.tool_use_id).flatMap(
					(row) => {
						const requests = this.get(
							this.requests,
							record.sessionId,
							row.requestId,
						);
						return requests.length === 0
							? []
							: [
									...requests,
									...this.get(this.messages, record.sessionId, row.messageId),
								];
					},
				),
			);
			return groups.every((group) => group.length > 0) ? groups.flat() : [];
		}
		// user_prompt identity can precede a login refresh. Only the later API
		// request's identity is evidence; prompt.id joins it to this exact message.
		return this.get(this.userPrompts, record.sessionId, record.uuid).flatMap(
			(row) => this.get(this.prompts, record.sessionId, row.promptId),
		);
	}
}
