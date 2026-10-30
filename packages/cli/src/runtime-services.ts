import type { CollectorSource } from "iteration-trace-contracts";
import { connectedConfig } from "./auto-connect.js";
import {
	backgroundServiceUsesRuntime,
	installBackgroundService,
	installedServiceSources,
} from "./background-service.js";
import { installCursorHooks } from "./cursor-hooks.js";
import { ensureRuntimeInstalled } from "./runtime-install.js";
import { readRuntimeState, runtimePaths } from "./runtime.js";

// Reinstalls each source's service so it starts through the launcher; with
// `restart`, services already using it restart to load the current version.
export async function refreshBackgroundServices(
	restart: boolean,
): Promise<readonly CollectorSource[]> {
	const refreshed: CollectorSource[] = [];
	for (const source of await installedServiceSources()) {
		const config = await connectedConfig(source);
		if (config === null) continue;
		if (
			!restart &&
			(await backgroundServiceUsesRuntime(config.dataDirectory, source))
		)
			continue;
		if ("cursorHome" in config)
			await installCursorHooks(config.cursorHome, config.dataDirectory);
		await installBackgroundService(config.dataDirectory, source);
		refreshed.push(source);
	}
	return refreshed;
}

// Brings a computer whose collectors run an older CLI onto this one. Nothing
// is installed where no collector has been set up.
export async function adoptRuntime(): Promise<void> {
	const installed = await installedServiceSources();
	if (
		installed.length === 0 &&
		(await readRuntimeState(runtimePaths())) === null
	)
		return;
	const installation = await ensureRuntimeInstalled(installed);
	await refreshBackgroundServices(installation.changed);
}
