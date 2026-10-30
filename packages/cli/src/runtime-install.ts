import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import type { CollectorSource } from "iteration-trace-contracts";
import {
	commitLauncher,
	compareVersions,
	confirmTrialSource,
	copyOwnPackage,
	launcherMatches,
	ownPackageRoot,
	pruneVersions,
	readPackageVersion,
	readRuntimeState,
	type RuntimePaths,
	runtimePaths,
	stageLauncher,
	versionEntry,
	withRuntimeLock,
	writeRuntimeState,
} from "./runtime.js";
import { switchVersion } from "./updater.js";

const execFile = promisify(execFileCallback);
const TRIAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

export async function ownVersion(): Promise<string> {
	return readPackageVersion(ownPackageRoot());
}

async function exists(filename: string): Promise<boolean> {
	try {
		await fs.access(filename);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

// Replaces the launcher only with one that resolves the installed version,
// since every collector start depends on it.
async function installLauncher(
	paths: RuntimePaths,
	version: string,
): Promise<void> {
	if (await launcherMatches(paths, version)) return;
	const staged = await stageLauncher(paths, version);
	try {
		const { stdout } = await execFile(
			process.execPath,
			[staged, "launcher-check"],
			{
				timeout: 30_000,
				windowsHide: true,
				env: { ...process.env, HOME: paths.home, USERPROFILE: paths.home },
			},
		);
		if (stdout.trim() !== (await readRuntimeState(paths))?.current)
			throw new Error(
				`The launcher from ${version} did not resolve the installed version.`,
			);
		await commitLauncher(paths, staged);
	} finally {
		await fs.rm(staged, { force: true });
	}
}

export type RuntimeInstallation = Readonly<{
	changed: boolean;
	version: string;
}>;

// Installs this CLI's version for background use when the computer has none
// or an older one. A newer global package replaces the installed version on
// trial, exactly like an automatic update.
export async function ensureRuntimeInstalled(
	expected: readonly CollectorSource[],
	paths = runtimePaths(),
): Promise<RuntimeInstallation> {
	const root = ownPackageRoot();
	const version = await readPackageVersion(root);
	const state = await readRuntimeState(paths);
	if (state === null) {
		await copyOwnPackage(paths, root, version);
		const created = await withRuntimeLock(paths, async () => {
			if ((await readRuntimeState(paths)) !== null) return false;
			await writeRuntimeState(paths, {
				version: 1,
				current: version,
				previous: null,
				trial: null,
				rejected: [],
				lastCheck: null,
				lastUpdate: null,
			});
			return true;
		});
		if (!created) return ensureRuntimeInstalled(expected, paths);
		await installLauncher(paths, version);
		return { changed: true, version };
	}
	const order = compareVersions(version, state.current);
	if (order < 0) return { changed: false, version: state.current };
	if (order === 0) {
		const repaired = !(await exists(versionEntry(paths, version, "cli.js")));
		if (repaired) await copyOwnPackage(paths, root, version);
		if (!(await exists(paths.launcher))) await installLauncher(paths, version);
		return { changed: repaired, version };
	}
	await copyOwnPackage(paths, root, version);
	await switchVersion(
		paths,
		state.current,
		version,
		state.trial?.previous ?? state.current,
		expected,
		Date.now(),
	);
	return { changed: true, version };
}

export type TrialProgress = "none" | "confirmed" | "completed";

// Records that this source collected on `version`. When every expected source
// has, the new launcher is installed and older versions are removed.
export async function confirmRuntimeTrial(
	version: string,
	source: CollectorSource,
	paths = runtimePaths(),
): Promise<TrialProgress> {
	const result = await withRuntimeLock(paths, async () => {
		const state = await readRuntimeState(paths);
		if (state === null) return null;
		const confirmation = confirmTrialSource(state, version, source, Date.now());
		if (confirmation === null) return null;
		await writeRuntimeState(paths, confirmation.state);
		return confirmation;
	});
	if (result === null) return "none";
	if (!result.completed) return "confirmed";
	await installLauncher(paths, version);
	await pruneVersions(
		paths,
		[version, result.state.previous].filter((item) => item !== null),
	);
	return "completed";
}

// A source that never starts again cannot confirm, so a trial without a
// rollback for a day is treated as healthy.
export async function expireRuntimeTrial(
	nowMs: number,
	paths = runtimePaths(),
): Promise<void> {
	await withRuntimeLock(paths, async () => {
		const state = await readRuntimeState(paths);
		if (
			state === null ||
			state.trial === null ||
			nowMs - state.trial.startedAtMs < TRIAL_EXPIRY_MS
		)
			return;
		await writeRuntimeState(paths, {
			...state,
			trial: null,
			lastUpdate: {
				from: state.trial.previous,
				to: state.trial.version,
				atMs: nowMs,
			},
		});
	});
}
