import {
	COLLECTOR_SOURCES,
	type CollectorSource,
} from "iteration-trace-contracts";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
	installLaunchAgent,
	launchAgentStatus,
	plistPath,
	uninstallLaunchAgent,
} from "./launch-agent.js";
import { ensureRuntimeInstalled } from "./runtime-install.js";
import {
	installSystemdUserService,
	ensureSystemdUserLinger,
	systemdLogPath,
	systemdUserServiceStatus,
	uninstallSystemdUserService,
	unitPath,
} from "./systemd-user.js";
import {
	installScheduledTask,
	scheduledTaskStatus,
	scheduledTaskUsesRuntime,
	taskDefinitionPath,
	uninstallScheduledTask,
	windowsLogPath,
} from "./task-scheduler.js";
import { runtimePaths } from "./runtime.js";

export function isCollectorPlatform(): boolean {
	return (
		process.platform === "darwin" ||
		process.platform === "linux" ||
		process.platform === "win32"
	);
}

export function requireCollectorPlatform(): void {
	if (!isCollectorPlatform()) {
		throw new Error(
			"Automatic startup is supported on macOS, Linux, and Windows only.",
		);
	}
}

export async function prepareBackgroundPersistence(): Promise<void> {
	requireCollectorPlatform();
	if (process.platform === "linux") await ensureSystemdUserLinger();
}

export function collectorLogPath(source: CollectorSource): string {
	if (process.platform === "linux") return systemdLogPath(source);
	if (process.platform === "win32") return windowsLogPath(source);
	return path.join(
		os.homedir(),
		"Library",
		"Logs",
		`iteration-${source}-collector.error.log`,
	);
}

export async function installBackgroundService(
	directory: string,
	source: CollectorSource,
): Promise<string> {
	requireCollectorPlatform();
	const installed = await installedServiceSources();
	await ensureRuntimeInstalled(
		installed.includes(source) ? installed : [...installed, source],
	);
	if (process.platform === "darwin")
		return installLaunchAgent(directory, source);
	if (process.platform === "linux")
		return installSystemdUserService(directory, source);
	return installScheduledTask(directory, source);
}

export async function uninstallBackgroundService(
	source: CollectorSource,
): Promise<void> {
	requireCollectorPlatform();
	if (process.platform === "darwin") return uninstallLaunchAgent(source);
	if (process.platform === "linux") return uninstallSystemdUserService(source);
	return uninstallScheduledTask(source);
}

export async function backgroundServiceStatus(
	source: CollectorSource,
): Promise<boolean> {
	requireCollectorPlatform();
	if (process.platform === "darwin") return launchAgentStatus(source);
	if (process.platform === "linux") return systemdUserServiceStatus(source);
	return scheduledTaskStatus(source);
}

// The installed service definition, or null when the source has no service.
async function backgroundServiceDefinition(
	source: CollectorSource,
): Promise<string | null> {
	requireCollectorPlatform();
	const file =
		process.platform === "darwin"
			? plistPath(source)
			: process.platform === "linux"
				? unitPath(source)
				: taskDefinitionPath(source);
	try {
		return await fs.readFile(
			file,
			process.platform === "win32" ? "utf16le" : "utf8",
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
}

export async function installedServiceSources(): Promise<CollectorSource[]> {
	const definitions = await Promise.all(
		COLLECTOR_SOURCES.map(backgroundServiceDefinition),
	);
	return COLLECTOR_SOURCES.filter((_, index) => definitions[index] !== null);
}

export async function backgroundServiceUsesRuntime(
	directory: string,
	source: CollectorSource,
): Promise<boolean> {
	if (process.platform === "win32")
		return scheduledTaskUsesRuntime(directory, source);
	return (
		(await backgroundServiceDefinition(source))?.includes(
			runtimePaths().launcher,
		) === true
	);
}
