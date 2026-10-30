import { collectorLogger } from "./logger.js";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	launchDecision,
	readRuntimeState,
	runtimePaths,
	versionEntry,
	withRuntimeLock,
	writeRuntimeState,
} from "./runtime.js";

// Installed once per computer and replaced only after a new version proves
// healthy, so it stays small and independent of any installed version.
async function launch(): Promise<void> {
	const [nodePath, , command, ...rest] = process.argv;
	const paths = runtimePaths();
	const installedState = async () => {
		const state = await readRuntimeState(paths);
		if (state === null) {
			throw new Error(
				"Iteration is not installed on this computer. Run iteration start for each source.",
			);
		}
		return state;
	};
	// Hooks run on every agent event, so only collector starts take the lock
	// needed to count trial starts.
	const version =
		command !== "run"
			? (await installedState()).current
			: await withRuntimeLock(paths, async () => {
					const state = await installedState();
					const decision = launchDecision(state, command, rest[0], Date.now());
					if (decision.state !== null)
						await writeRuntimeState(paths, decision.state);
					if (decision.rolledBack !== null) {
						collectorLogger({
							level: "error",
							operation: "runtime_rollback",
							from: decision.rolledBack.from,
							to: decision.rolledBack.to,
						});
					}
					return decision.version;
				});
	const entry = versionEntry(
		paths,
		version,
		command === "cursor-hook" ? "cursor-hook-entry.js" : "cli.js",
	);
	if (command === "launcher-check") {
		await fs.access(entry);
		process.stdout.write(`${version}\n`);
		return;
	}
	process.argv = [
		nodePath ?? process.execPath,
		entry,
		...(command === "cursor-hook" ? rest : [command ?? "", ...rest]),
	];
	process.env.ITERATION_RUNTIME_VERSION = version;
	await import(pathToFileURL(entry).href);
}

launch().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Iteration could not start."}\n`,
	);
	process.exitCode = 1;
});
