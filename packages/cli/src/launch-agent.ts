import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CollectorSource } from "iteration-trace-contracts";
import { runtimePaths, stableNodePath } from "./runtime.js";

const execFile = promisify(execFileCallback);
function label(source: CollectorSource): string {
	return `com.iteration.${source}-collector`;
}
const LAUNCHCTL_TIMEOUT_MS = 5_000;
const RESTART_TIMEOUT_MS = 10_000;
const RESTART_POLL_MS = 200;

export type LaunchAgentRestart = {
	isLoaded(timeoutMs: number): Promise<boolean>;
	bootstrap(timeoutMs: number): Promise<void>;
	wait(delayMs: number): Promise<void>;
	now(): number;
};

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function plistPath(
	source: CollectorSource,
	homeDirectory = os.homedir(),
): string {
	return path.join(
		homeDirectory,
		"Library",
		"LaunchAgents",
		`${label(source)}.plist`,
	);
}

export function launchAgentPlist(
	launcherPath = runtimePaths().launcher,
	nodePath = process.execPath,
	logDirectory = path.join(os.homedir(), "Library", "Logs"),
	dataDirectory = path.join(
		os.homedir(),
		".config",
		"iteration",
		"codex-collector",
	),
	source: CollectorSource = "codex",
): string {
	const argumentsList = [
		nodePath,
		launcherPath,
		"run",
		source,
		"--data-directory",
		dataDirectory,
	];
	const argumentsXml = argumentsList
		.map((argument) => `<string>${xml(argument)}</string>`)
		.join("");
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0"><dict>',
		`<key>Label</key><string>${label(source)}</string>`,
		`<key>ProgramArguments</key><array>${argumentsXml}</array>`,
		"<key>RunAtLoad</key><true/>",
		"<key>KeepAlive</key><true/>",
		"<key>ThrottleInterval</key><integer>10</integer>",
		`<key>StandardOutPath</key><string>${xml(path.join(logDirectory, `iteration-${source}-collector.log`))}</string>`,
		`<key>StandardErrorPath</key><string>${xml(path.join(logDirectory, `iteration-${source}-collector.error.log`))}</string>`,
		"</dict></plist>",
	].join("");
}

function launchctlTarget(): string {
	const getUserId = process.getuid;
	if (getUserId === undefined) {
		throw new Error("Could not determine the current macOS user id.");
	}
	const userId = getUserId();
	if (userId === undefined)
		throw new Error("Could not determine the current macOS user id.");
	return `gui/${userId}`;
}

function serviceMissing(error: unknown): boolean {
	const details = error as NodeJS.ErrnoException & { stderr?: string };
	return (
		String(details.code) === "113" ||
		details.stderr?.includes("Could not find service") === true
	);
}

async function serviceLoaded(
	target: string,
	source: CollectorSource,
	timeoutMs = LAUNCHCTL_TIMEOUT_MS,
): Promise<boolean> {
	try {
		await execFile("launchctl", ["print", `${target}/${label(source)}`], {
			timeout: timeoutMs,
		});
		return true;
	} catch (error) {
		if (serviceMissing(error)) return false;
		throw error;
	}
}

async function bootoutIfLoaded(
	target: string,
	source: CollectorSource,
): Promise<boolean> {
	if (!(await serviceLoaded(target, source))) return false;
	await execFile("launchctl", ["bootout", `${target}/${label(source)}`], {
		timeout: LAUNCHCTL_TIMEOUT_MS,
	});
	return true;
}

function transientBootstrapFailure(error: unknown): boolean {
	const details = error as { code?: number | string; stderr?: string };
	return (
		String(details.code) === "5" ||
		/^Bootstrap failed:\s*5\b/m.test(details.stderr ?? "")
	);
}

function restartTimeoutError(lastBootstrapFailure: unknown): Error {
	return new Error(
		lastBootstrapFailure === undefined
			? "The previous Codex collector did not stop within 10 seconds."
			: "launchctl bootstrap still failed with error 5 after 10 seconds.",
		{ cause: lastBootstrapFailure },
	);
}

export async function bootstrapAfterBootout(
	wasLoaded: boolean,
	control: LaunchAgentRestart,
): Promise<void> {
	if (!wasLoaded) {
		await control.bootstrap(LAUNCHCTL_TIMEOUT_MS);
		return;
	}

	const deadline = control.now() + RESTART_TIMEOUT_MS;
	let lastBootstrapFailure: unknown;
	while (true) {
		let remaining = deadline - control.now();
		if (remaining <= 0) {
			throw restartTimeoutError(lastBootstrapFailure);
		}
		if (!(await control.isLoaded(Math.min(remaining, LAUNCHCTL_TIMEOUT_MS)))) {
			remaining = deadline - control.now();
			if (remaining <= 0) continue;
			try {
				await control.bootstrap(Math.min(remaining, LAUNCHCTL_TIMEOUT_MS));
				return;
			} catch (error) {
				if (!transientBootstrapFailure(error)) throw error;
				lastBootstrapFailure = error;
			}
		}
		remaining = deadline - control.now();
		if (remaining > 0) {
			await control.wait(Math.min(remaining, RESTART_POLL_MS));
		}
	}
}

export async function installLaunchAgent(
	dataDirectory?: string,
	source: CollectorSource = "codex",
): Promise<string> {
	if (process.platform !== "darwin") {
		throw new Error("Automatic startup is currently supported on macOS only.");
	}
	const file = plistPath(source);
	const launchAgents = path.dirname(file);
	const logs = path.join(os.homedir(), "Library", "Logs");
	await fs.mkdir(launchAgents, { recursive: true, mode: 0o755 });
	await fs.mkdir(logs, { recursive: true, mode: 0o755 });
	await fs.writeFile(
		file,
		launchAgentPlist(
			undefined,
			await stableNodePath(),
			undefined,
			dataDirectory ??
				path.join(os.homedir(), ".config", "iteration", `${source}-collector`),
			source,
		),
		{ encoding: "utf8", mode: 0o644 },
	);
	const target = launchctlTarget();
	const wasLoaded = await bootoutIfLoaded(target, source);
	await bootstrapAfterBootout(wasLoaded, {
		isLoaded: (timeoutMs) => serviceLoaded(target, source, timeoutMs),
		bootstrap: async (timeoutMs) => {
			await execFile("launchctl", ["bootstrap", target, file], {
				timeout: timeoutMs,
			});
		},
		wait: sleep,
		now: Date.now,
	});
	await execFile(
		"launchctl",
		["kickstart", "-p", `${target}/${label(source)}`],
		{
			timeout: LAUNCHCTL_TIMEOUT_MS,
		},
	);
	return file;
}

export async function uninstallLaunchAgent(
	source: CollectorSource = "codex",
): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error("Automatic startup is currently supported on macOS only.");
	}
	const file = plistPath(source);
	await bootoutIfLoaded(launchctlTarget(), source);
	await fs.rm(file, { force: true });
}

export async function launchAgentStatus(
	source: CollectorSource = "codex",
): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	try {
		const { stdout } = await execFile("launchctl", [
			"print",
			`${launchctlTarget()}/${label(source)}`,
		]);
		return launchAgentRunning(stdout);
	} catch {
		return false;
	}
}

export function launchAgentRunning(output: string): boolean {
	const state = output.match(/^\s*state = ([^\r\n]+)$/m);
	return state?.[1]?.trim() === "running";
}
