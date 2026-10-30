import {
	canonicalRepository,
	isLaunchDirectory,
	vaultAccountSchema,
} from "iteration-trace-contracts";
import * as z from "zod";
import { passwordSchema as password } from "./password.js";

const email = z
	.email()
	.max(254)
	.transform((value) => value.trim().toLowerCase());
const name = z.string().trim().min(1).max(160);
export const setupSchema = z
	.object({
		bootstrapToken: z.string().min(32).max(256),
		name,
		email,
		password,
		displayName: name,
	})
	.strict();
export const loginSchema = z
	.object({ email, password: z.string().min(1).max(256) })
	.strict();
export const joinSchema = z
	.object({
		token: z.string().min(32).max(256),
		password,
		name: name.optional(),
	})
	.strict();
export const invitationSchema = z
	.object({ email, name, role: z.enum(["admin", "member"]) })
	.strict();
export const memberChangeSchema = z
	.object({
		disabled: z.boolean(),
		role: z.enum(["admin", "member"]).optional(),
	})
	.strict();
export const enrollmentSchema = z
	.object({ deviceName: name, source: z.enum(["claude", "codex", "cursor"]) })
	.strict();
export const ownPolicySchema = z
	.object({
		accounts: z.array(vaultAccountSchema).max(100),
		locations: z
			.array(
				z
					.string()
					.max(4096)
					.refine(isLaunchDirectory, "Use an absolute directory path."),
			)
			.max(100),
	})
	.strict();
const repository = z
	.string()
	.min(1)
	.max(2048)
	.transform((value, context) => {
		const normalized = canonicalRepository(value);
		if (normalized === null) {
			context.addIssue({
				code: "custom",
				message: "Use a Git repository HTTPS or SSH URL.",
			});
			return z.NEVER;
		}
		return normalized;
	});
export const repositoriesSchema = z
	.object({ repositories: z.array(repository).max(1000) })
	.strict();
export const pageSchema = z
	.object({
		cursor: z.string().min(1).max(2048).optional(),
		limit: z.coerce.number().int().min(1).max(100).default(50),
	})
	.strict();
