import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CollectorSource } from "iteration-trace-contracts";
import { runtimePaths, stableNodePath } from "./runtime.js";

const execFile = promisify(execFileCallback);
const SYSTEMCTL_TIMEOUT_MS = 10_000;
const LOGINCTL_TIMEOUT_MS = 10_000;

function currentUserId(): string {
	const userId = process.getuid?.();
	if (userId === undefined)
		throw new Error("Could not determine the current Linux user id.");
	return String(userId);
}

async function lingerState(userId: string): Promise<"yes" | "no"> {
	const { stdout } = await execFile(
		"loginctl",
		["show-user", userId, "--property=Linger", "--value"],
		{ timeout: LOGINCTL_TIMEOUT_MS },
	);
	const state = stdout.trim();
	if (state === "yes" || state === "no") return state;
	throw new Error(
		`Could not read Linux background service setting: ${state || "empty response"}.`,
	);
}

export async function ensureSystemdUserLinger(): Promise<void> {
	const userId = currentUserId();
	let state: "yes" | "no" = "no";
	let queryFailure: unknown;
	try {
		state = await lingerState(userId);
	} catch (error) {
		queryFailure = error;
	}
	if (state === "yes") return;
	try {
		await execFile("loginctl", ["--no-ask-password", "enable-linger", userId], {
			timeout: LOGINCTL_TIMEOUT_MS,
		});
	} catch (userError) {
		try {
			await execFile("sudo", ["-n", "loginctl", "enable-linger", userId], {
				timeout: LOGINCTL_TIMEOUT_MS,
			});
		} catch (adminError) {
			throw new Error(
				"This server does not allow Iteration to keep collecting after you log out. Ask an administrator to allow background services for your account, then run iteration connect again.",
				{
					cause: new AggregateError(
						queryFailure
							? [queryFailure, userError, adminError]
							: [userError, adminError],
						"Could not enable Linux background collection.",
					),
				},
			);
		}
	}
	try {
		if ((await lingerState(userId)) === "yes") return;
	} catch (error) {
		throw new Error(
			"Could not verify Linux background collection after logout.",
			{
				cause: error,
			},
		);
	}
	throw new Error("Linux did not enable background collection after logout.");
}

function unitName(source: CollectorSource): string {
	return `iteration-${source}-collector.service`;
}

export function unitPath(source: CollectorSource): string {
	return path.join(
		os.homedir(),
		".config",
		"systemd",
		"user",
		unitName(source),
	);
}

export function systemdLogPath(source: CollectorSource): string {
	return path.join(
		os.homedir(),
		".config",
		"iteration",
		"logs",
		`iteration-${source}-collector.error.log`,
	);
}

function unitValue(value: string): string {
	if (/[\r\n\0]/.test(value))
		throw new Error("Collector paths cannot contain line breaks.");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function systemdUserUnit(
	launcherPath = runtimePaths().launcher,
	nodePath = process.execPath,
	dataDirectory = path.join(
		os.homedir(),
		".config",
		"iteration",
		"codex-collector",
	),
	source: CollectorSource = "codex",
	outputPath = path.join(
		os.homedir(),
		".config",
		"iteration",
		"logs",
		`iteration-${source}-collector.log`,
	),
	errorPath = systemdLogPath(source),
): string {
	return [
		"[Unit]",
		`Description=Iteration ${source} collector`,
		"[Service]",
		"Type=exec",
		`ExecStart=${[nodePath, launcherPath, "run", source, "--data-directory", dataDirectory].map(unitValue).join(" ")}`,
		"Restart=always",
		"RestartSec=5",
		`StandardOutput=append:${unitValue(outputPath)}`,
		`StandardError=append:${unitValue(errorPath)}`,
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

async function systemctl(...args: string[]): Promise<string> {
	const { stdout } = await execFile("systemctl", ["--user", ...args], {
		timeout: SYSTEMCTL_TIMEOUT_MS,
	});
	return stdout.trim();
}

export async function installSystemdUserService(
	dataDirectory: string,
	source: CollectorSource,
): Promise<string> {
	await ensureSystemdUserLinger();
	const file = unitPath(source);
	const logDirectory = path.dirname(systemdLogPath(source));
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
	await fs.writeFile(
		file,
		systemdUserUnit(undefined, await stableNodePath(), dataDirectory, source),
		{
			encoding: "utf8",
			mode: 0o644,
		},
	);
	await systemctl("daemon-reload");
	await systemctl("enable", unitName(source));
	await systemctl("restart", unitName(source));
	return file;
}

export async function uninstallSystemdUserService(
	source: CollectorSource,
): Promise<void> {
	const file = unitPath(source);
	try {
		await fs.access(file);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return;
		throw error;
	}
	await systemctl("disable", "--now", unitName(source));
	await fs.rm(file);
	await systemctl("daemon-reload");
}

export async function systemdUserServiceStatus(
	source: CollectorSource,
): Promise<boolean> {
	const state = await systemctl(
		"show",
		"--property=ActiveState",
		"--value",
		unitName(source),
	);
	if (state === "active") return true;
	if (state === "inactive" || state === "failed") return false;
	throw new Error(
		`Could not determine ${source} collector service state: ${state || "empty response"}.`,
	);
}
