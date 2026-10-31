import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
	process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)),
);
const forbidden = [
	[/\bClerk\b|\bCLERK_[A-Z_]+\b|@clerk\//i, "consumer identity provider"],
	[/\buseiteration\.com\b/i, "Iteration cloud endpoint"],
	[/\biteration-(?:cli|collector-contracts)\b/, "private consumer package"],
	[
		/\/api\/traces\/(?:collector-auth|collector-progress|friction-summary|codex-billing|cursor-billing)\b/,
		"Iteration product API",
	],
	[
		/\b(?:parseCollectorEnrollment\w*|collectorEnrollment\w*|CollectorEnrollment\w*|CollectorExpansion\w*|CollectorFriction\w*|collectorFriction\w*|codexBilling\w*|cursorBilling\w*)\b/,
		"Iteration product contract",
	],
	[
		/\b(?:billing_kind|billing_paid_usd|codex_billing_[a-z_]+|tool_activity|usage_activity|usage_after_error|trace_shell_reads_only|trace_code_mode_activity|trace_tool_activity|trace_usage_activity)\b/,
		"private billing or activity interpretation",
	],
];

async function check(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			await check(filename);
			continue;
		}
		if (
			!entry.isFile() ||
			!/\.(?:[cm]?[jt]sx?|sql|json)$/.test(entry.name) ||
			/\.test\./.test(entry.name)
		)
			continue;
		const source = await readFile(filename, "utf8");
		for (const [pattern, reason] of forbidden) {
			if (pattern.test(source)) {
				throw new Error(
					`${path.relative(root, filename)} contains ${reason}; keep consumer-specific integration outside Trace Vault.`,
				);
			}
		}
	}
}

await check(path.join(root, "packages"));
process.stdout.write(
	"Trace Vault production source is independent of Iteration product integration.\n",
);
