import os from "node:os";
import path from "node:path";
import {
	vaultCapturePolicySchema,
	type CollectorSource,
} from "iteration-trace-contracts";
import * as z from "zod";
import { collectorFetch, type CollectorFetcher } from "./collector-fetch.js";
import { vaultOrigin, vaultRequest } from "./vault-api.js";
import { resolveCaptureLocation } from "./vault-scope.js";
import { CLAUDE_ACCOUNT_VERSION } from "./claude-account.js";
import {
	assertFreshCollectorDirectory,
	collectorPaths,
	prepareSourceInitialState,
	saveConfig,
	saveState,
	type CollectorConfig,
} from "./storage.js";

const memberSessionSchema = z.object({
	token: z.string().regex(/^vs_[A-Za-z0-9_-]{43}$/),
	member: z.object({}),
});

// The native server distinguishes device and member credentials by prefix;
// Iteration's enrollment parser intentionally accepts only unprefixed tokens.
const vaultEnrollmentSchema = z
	.object({
		status: z.literal("enrolled"),
		token: z.string().regex(/^vd_[A-Za-z0-9_-]{43}$/),
		deviceId: z.uuid(),
		organizationId: z.uuid(),
		organizationName: z.string().min(1).max(160),
	})
	.strict();

export type VaultPrompts = Readonly<{
	secret: (label: string) => Promise<string>;
	text: (label: string) => Promise<string>;
	approve: (description: string) => Promise<boolean>;
}>;

export function defaultVaultDirectory(
	origin: string,
	source: CollectorSource,
): string {
	const host = new URL(vaultOrigin(origin)).host.replace(
		/[^a-zA-Z0-9.-]/g,
		"_",
	);
	return path.join(os.homedir(), ".config", "trace-vault", host, source);
}

export async function vaultMemberLogin(
	origin: string,
	prompts: VaultPrompts,
	join: boolean,
	email?: string,
	fetcher: CollectorFetcher = collectorFetch,
): Promise<string> {
	const identity = join
		? { token: await prompts.secret("Invitation token: ") }
		: { email: email ?? (await prompts.text("Company email: ")) };
	const password = await prompts.secret(
		join ? "Choose a password: " : "Password: ",
	);
	if (password.length === 0 || password.length > 4096)
		throw new Error("Password must contain 1–4096 characters.");
	const result = await vaultRequest(
		origin,
		join ? "/api/auth/join" : "/api/auth/login",
		null,
		"POST",
		{ ...identity, password },
		fetcher,
	);
	const parsed = memberSessionSchema.safeParse(result);
	if (!parsed.success)
		throw new Error("Company vault returned an invalid sign-in response.");
	return parsed.data.token;
}

export async function enrollVault(
	options: Readonly<{
		origin: string;
		source: CollectorSource;
		home: string;
		directory: string;
		join: boolean;
		email?: string;
		locations: readonly string[];
	}>,
	prompts: VaultPrompts,
	fetcher: CollectorFetcher = collectorFetch,
): Promise<CollectorConfig> {
	const origin = vaultOrigin(options.origin);
	const paths = collectorPaths(options.directory);
	await assertFreshCollectorDirectory(paths, options.source);
	const token = await vaultMemberLogin(
		origin,
		prompts,
		options.join,
		options.email,
		fetcher,
	);
	const policyResult = vaultCapturePolicySchema.safeParse(
		await vaultRequest(
			origin,
			"/api/me/capture-rules",
			token,
			"GET",
			undefined,
			fetcher,
		),
	);
	if (!policyResult.success)
		throw new Error("Company vault returned invalid capture rules.");
	const policy = policyResult.data;
	const locations = [
		...new Set([
			...policy.locations,
			...options.locations.map(resolveCaptureLocation),
		]),
	];
	const approved = await prompts.approve(
		[
			`Upload matching existing history and ongoing ${options.source} records to the company vault at ${origin}?`,
			`Company repositories: ${policy.repositories.join(", ") || "none"}`,
			`Explicit local roots: ${locations.join(", ") || "none"}`,
			"Only record/turn-scoped repository evidence or an explicit local root qualifies. Unmatched originals stay in the agent's files.",
			`Claude account capture requires explicit metadata-only account-setup (terminal Claude Code ${CLAUDE_ACCOUNT_VERSION}) and individual request/message evidence. Codex/Cursor account capture is unsupported; account/session labels never authorize history.`,
			"Cursor history without record-level workspace evidence requires explicit approval of its transcript storage location. No content telemetry is enabled.",
		].join("\n"),
	);
	if (!approved)
		throw new Error(
			"Company vault enrollment cancelled; no collector credentials were saved.",
		);
	if (options.locations.length > 0) {
		const updated = await vaultRequest(
			origin,
			"/api/me/capture-rules",
			token,
			"PUT",
			{ accounts: policy.accounts, locations },
			fetcher,
		);
		if (!vaultCapturePolicySchema.safeParse(updated).success)
			throw new Error("Company vault returned invalid updated capture rules.");
	}
	const result = vaultEnrollmentSchema.safeParse(
		await vaultRequest(
			origin,
			"/api/collector/enroll",
			token,
			"POST",
			{ deviceName: os.hostname(), source: options.source },
			fetcher,
		),
	);
	if (!result.success)
		throw new Error("Company vault did not enroll this collector.");
	const enrolled = result.data;
	const connection = {
		endpoint: new URL("/api/traces/ingest", origin).href,
		token: enrolled.token,
		dataDirectory: path.resolve(options.directory),
		organizationId: enrolled.organizationId,
		organizationName: enrolled.organizationName,
		destination: "vault" as const,
	};
	const home = path.resolve(options.home);
	const config: CollectorConfig =
		options.source === "codex"
			? { ...connection, codexHome: home }
			: options.source === "claude"
				? { ...connection, source: "claude", claudeHome: home }
				: { ...connection, source: "cursor", cursorHome: home };
	await saveState(
		await prepareSourceInitialState(options.source, home, true),
		paths,
	);
	await saveConfig(config, paths);
	return config;
}
