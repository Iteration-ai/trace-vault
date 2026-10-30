import fs from "node:fs";
import path from "node:path";
import {
	canonicalRepository,
	permitsVaultCapture,
	type CollectorSource,
	type TraceEvent,
	type VaultCaptureAuthorization,
	type VaultCapturePolicy,
} from "iteration-trace-contracts";
import * as z from "zod";
import { gitRepositoryUrl } from "./git-repository.js";
import {
	claudeCaptureIdentity,
	type ClaudeAccountIndex,
} from "./claude-account.js";

const scopeRecordSchema = z.object({
	type: z.string().optional(),
	cwd: z.string().optional(),
	payload: z
		.object({
			type: z.string().optional(),
			cwd: z.string().optional(),
			git: z.object({ repository_url: z.string().optional() }).optional(),
		})
		.optional(),
	input: z
		.object({
			cwd: z.string().optional(),
			workspace_roots: z.array(z.string()).optional(),
		})
		.optional(),
});

// Resolve existing ancestors too: a missing child under a symlink must not
// turn an approved root into permission for the symlink's private target.
export function resolveCaptureLocation(value: string): string {
	if (!path.isAbsolute(value))
		throw new Error("Capture locations must be absolute paths.");
	let ancestor = path.normalize(value);
	const suffix: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(ancestor), ...suffix);
		} catch (error) {
			if (
				!(
					error instanceof Error &&
					"code" in error &&
					(error.code === "ENOENT" || error.code === "ENOTDIR")
				)
			)
				throw error;
			const parent = path.dirname(ancestor);
			if (parent === ancestor) throw error;
			suffix.unshift(path.basename(ancestor));
			ancestor = parent;
		}
	}
}

function within(root: string, candidate: string): boolean {
	if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
	const relative = path.relative(
		resolveCaptureLocation(root),
		resolveCaptureLocation(candidate),
	);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function codexRecordScope(
	record: z.infer<typeof scopeRecordSchema>,
	filename: string,
	cwds: Record<string, string>,
): Readonly<{ cwd: string | undefined; repository?: string }> {
	if (record.type === "session_meta" || record.type === "turn_context") {
		delete cwds[filename];
		const cwd = record.payload?.cwd;
		if (record.type === "turn_context" && cwd && path.isAbsolute(cwd))
			cwds[filename] = cwd;
		// Launch Git evidence describes only the launch record, not a resumed turn.
		return { cwd, repository: record.payload?.git?.repository_url };
	}
	const cwd = cwds[filename];
	if (
		record.type === "event_msg" &&
		["task_started", "task_complete", "turn_complete", "turn_aborted"].includes(
			record.payload?.type ?? "",
		)
	)
		delete cwds[filename];
	return { cwd: record.payload?.type === "task_started" ? undefined : cwd };
}

function recordScope(
	source: CollectorSource,
	record: z.infer<typeof scopeRecordSchema>,
	filename: string,
	cwds: Record<string, string>,
): Readonly<{ cwd: string | undefined; repository?: string }> {
	if (source === "codex") return codexRecordScope(record, filename, cwds);
	if (source === "claude") return { cwd: record.cwd };
	// A multi-root Cursor event does not identify which root supplied its content.
	return {
		cwd:
			record.input?.cwd ??
			(record.input?.workspace_roots?.length === 1
				? record.input.workspace_roots[0]
				: undefined),
	};
}

export function authorizeVaultRecord(
	policy: VaultCapturePolicy,
	source: CollectorSource,
	line: string,
	filename: string,
	cwds: Record<string, string>,
	accounts: ClaudeAccountIndex | null = null,
): VaultCaptureAuthorization | null {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		delete cwds[filename];
		return null;
	}
	const account =
		source === "claude" ? accounts?.authorize(policy, decoded) : null;
	if (account) {
		accounts?.observeAuthorizedNative(decoded);
		return account;
	}
	const parsed = scopeRecordSchema.safeParse(decoded);
	if (!parsed.success) {
		delete cwds[filename];
		return null;
	}
	const scope = recordScope(source, parsed.data, filename, cwds);
	const { cwd } = scope;
	const authorization = (
		basis: "location" | "repository",
		reference: string,
	): VaultCaptureAuthorization => ({
		revision: policy.revision,
		basis,
		reference,
	});
	for (const root of policy.locations) {
		if (within(root, filename) || (cwd !== undefined && within(root, cwd)))
			return authorization("location", root);
	}
	const repository =
		scope.repository ??
		(cwd && path.isAbsolute(cwd) ? gitRepositoryUrl(cwd, true) : null);
	const canonical = repository ? canonicalRepository(repository) : null;
	return canonical !== null && policy.repositories.includes(canonical)
		? authorization("repository", canonical)
		: null;
}

export function reauthorizeVaultEvent(
	policy: VaultCapturePolicy,
	event: TraceEvent,
	accounts: ClaudeAccountIndex | null = null,
): TraceEvent | null {
	if (event.capture === undefined) return null;
	if (event.capture.basis === "account") {
		const capture = accounts?.authorize(policy, event.payload.captureIdentity);
		return capture && capture.reference === event.capture.reference
			? { ...event, capture }
			: null;
	}
	const capture = { ...event.capture, revision: policy.revision };
	return permitsVaultCapture(policy, capture) ? { ...event, capture } : null;
}

export function scopeVaultEvents(
	events: readonly TraceEvent[],
	capture: VaultCaptureAuthorization | undefined,
	line: string,
): readonly TraceEvent[] {
	if (capture === undefined) return events;
	if (capture.basis !== "account")
		return events.map((event) => ({ ...event, capture }));
	const captureIdentity = claudeCaptureIdentity(JSON.parse(line));
	return events.map((event) => ({
		...event,
		capture,
		payload: { ...event.payload, captureIdentity },
	}));
}
