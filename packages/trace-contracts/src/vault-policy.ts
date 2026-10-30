import * as z from "zod";
import { COLLECTOR_SOURCES } from "./collector-source.ts";

export const vaultAccountSchema = z
	.object({
		source: z.enum(COLLECTOR_SOURCES),
		accountId: z.string().min(1).max(255),
		organizationId: z.string().min(1).max(255).nullable(),
	})
	.strict();

export const vaultCapturePolicySchema = z
	.object({
		revision: z.number().int().positive(),
		repositories: z.array(z.string().min(1).max(2048)).max(1000),
		accounts: z.array(vaultAccountSchema).max(100),
		locations: z.array(z.string().min(1).max(4096)).max(100),
	})
	.strict();

export const vaultCaptureAuthorizationSchema = z
	.object({
		revision: z.number().int().positive(),
		basis: z.enum(["account", "repository", "location"]),
		reference: z.string().min(1).max(4096),
	})
	.strict();

export type VaultAccount = z.infer<typeof vaultAccountSchema>;
export type VaultCapturePolicy = z.infer<typeof vaultCapturePolicySchema>;
export type VaultCaptureAuthorization = z.infer<
	typeof vaultCaptureAuthorizationSchema
>;

export function vaultAccountReference(account: VaultAccount): string {
	return JSON.stringify([
		account.source,
		account.accountId,
		account.organizationId,
	]);
}

export function permitsVaultCapture(
	policy: VaultCapturePolicy,
	authorization: VaultCaptureAuthorization,
): boolean {
	if (authorization.revision !== policy.revision) return false;
	if (authorization.basis === "repository")
		return policy.repositories.includes(authorization.reference);
	if (authorization.basis === "location")
		return policy.locations.includes(authorization.reference);
	return policy.accounts.some(
		(account) => vaultAccountReference(account) === authorization.reference,
	);
}

export function canonicalRepository(value: string): string | null {
	const canonical = /^[a-zA-Z0-9.-]+(?::\d+)?\/[^\s?#]+$/.test(value);
	const scp = /^(?:git@)?([a-zA-Z0-9.-]+):([^/\s?#][^\s?#]*)$/.exec(value);
	let url: URL;
	try {
		url = new URL(
			canonical
				? `https://${value}`
				: scp
					? `ssh://${scp[1]}/${scp[2]}`
					: value,
		);
	} catch {
		return null;
	}
	if (
		!["https:", "ssh:"].includes(url.protocol) ||
		url.password ||
		url.search ||
		url.hash
	)
		return null;
	if (url.username && url.username !== "git") return null;
	const repositoryPath = url.pathname
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/, "");
	if (
		!url.hostname ||
		!repositoryPath.includes("/") ||
		repositoryPath.includes("..")
	)
		return null;
	const host = url.hostname.toLowerCase();
	const path = ["github.com", "bitbucket.org"].includes(host)
		? repositoryPath.toLowerCase()
		: repositoryPath;
	return `${host}${url.port ? `:${url.port}` : ""}/${path}`;
}
