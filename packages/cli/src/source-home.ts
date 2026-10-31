import os from "node:os";
import path from "node:path";
import type { CollectorSource } from "iteration-trace-contracts";

export function sourceHome(source: CollectorSource): string {
	return path.resolve(
		source === "codex"
			? (process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"))
			: source === "claude"
				? (process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"))
				: path.join(os.homedir(), ".cursor"),
	);
}
