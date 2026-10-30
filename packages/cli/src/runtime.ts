import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	COLLECTOR_SOURCES,
	type CollectorSource,
} from "iteration-trace-contracts";
import * as z from "zod";
import { ensurePrivateDirectory } from "./private-storage.js";

// Background services and Cursor hooks run the CLI through a launcher in this
// directory, never through the package manager's install path, so upgrading
// or removing the global package cannot stop collection.
export type RuntimePaths = Readonly<{
	home: string;
	root: string;
	versions: string;
	staging: string;
	state: string;
	settings: string;
	lock: string;
	updateLock: string;
	launcher: string;
}>;

export function runtimePaths(home = os.homedir()): RuntimePaths {
	const root = path.join(home, ".config", "iteration", "runtime");
	return {
		home,
		root,
		versions: path.join(root, "versions"),
		staging: path.join(root, "staging"),
		state: path.join(root, "state.json"),
		settings: path.join(root, "settings.json"),
		lock: path.join(root, "state.lock"),
		updateLock: path.join(root, "update.lock"),
		launcher: path.join(root, "launcher.js"),
	};
}

const DEFAULT_UPDATE_REGISTRY = "https://registry.npmjs.org/";

// A new version that stops this many times on one source before confirming a
// healthy collection pass is rolled back.
const MAX_TRIAL_STARTS = 3;

const VERSION_PATTERN =
	/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const versionSchema = z.string().regex(VERSION_PATTERN);
const sourceSchema = z.enum(COLLECTOR_SOURCES);
const timeSchema = z.number().int().min(0);

// Loose objects keep state readable by the previous release after a rollback,
// so fields may be added but never renamed or retyped.
const trialSchema = z
	.object({
		version: versionSchema,
		previous: versionSchema,
		startedAtMs: timeSchema,
		expected: z.array(sourceSchema),
		starts: z.partialRecord(sourceSchema, z.number().int().min(0)),
		confirmed: z.array(sourceSchema),
	})
	.loose();

const runtimeStateSchema = z
	.object({
		version: z.literal(1),
		current: versionSchema,
		previous: versionSchema.nullable(),
		trial: trialSchema.nullable(),
		rejected: z
			.array(
				z
					.object({
						version: versionSchema,
						reason: z.string().max(500),
						atMs: timeSchema,
					})
					.loose(),
			)
			.max(20),
		lastCheck: z
			.object({ atMs: timeSchema, error: z.string().max(500).nullable() })
			.loose()
			.nullable(),
		lastUpdate: z
			.object({ from: versionSchema, to: versionSchema, atMs: timeSchema })
			.loose()
			.nullable(),
	})
	.loose();

export type RuntimeState = z.infer<typeof runtimeStateSchema>;

const settingsSchema = z
	.object({
		autoUpdate: z.boolean(),
		registry: z.string().url(),
	})
	.loose();

export type RuntimeSettings = z.infer<typeof settingsSchema>;

function errorCode(error: unknown): string | null {
	if (error instanceof Error && "code" in error) return String(error.code);
	return null;
}

export function isVersion(value: string): boolean {
	return VERSION_PATTERN.test(value);
}

function versionParts(value: string): readonly [number, number, number] {
	const match = VERSION_PATTERN.exec(value);
	if (match === null) throw new Error(`Invalid Iteration version ${value}.`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
	const a = versionParts(left);
	const b = versionParts(right);
	for (let index = 0; index < 3; index += 1) {
		const difference = a[index]! - b[index]!;
		if (difference !== 0) return Math.sign(difference);
	}
	return 0;
}

// Published packages declare `>=MAJOR[.MINOR[.PATCH]]`; any other range is
// refused rather than guessed.
export function nodeRequirement(
	range: string | undefined,
	nodeVersion: string,
): Readonly<{ ok: true } | { ok: false; reason: string }> {
	const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(
		range?.trim() ?? "",
	);
	if (match === null) {
		return {
			ok: false,
			reason: `it declares an unsupported Node.js requirement (${range ?? "none"})`,
		};
	}
	const required = [
		Number(match[1]),
		Number(match[2] ?? 0),
		Number(match[3] ?? 0),
	];
	const actual = nodeVersion.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = (actual[index] ?? 0) - required[index]!;
		if (difference > 0) return { ok: true };
		if (difference < 0) {
			return {
				ok: false,
				reason: `it needs Node.js ${range} and this computer runs ${nodeVersion}`,
			};
		}
	}
	return { ok: true };
}

export async function ensureRuntimeDirectory(
	paths: RuntimePaths,
): Promise<void> {
	for (const directory of [paths.root, paths.versions, paths.staging]) {
		await ensurePrivateDirectory(directory);
	}
}

async function writeFileAtomic(
	filename: string,
	contents: string,
	mode: number,
): Promise<void> {
	const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
	const handle = await fs.open(temporary, "w", mode);
	try {
		await handle.writeFile(contents, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, filename);
}

export async function readRuntimeState(
	paths: RuntimePaths,
): Promise<RuntimeState | null> {
	let contents: string;
	try {
		contents = await fs.readFile(paths.state, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Iteration runtime state at ${paths.state} is invalid.`, {
			cause: error,
		});
	}
	const parsed = runtimeStateSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new Error(`Iteration runtime state at ${paths.state} is invalid.`, {
			cause: parsed.error,
		});
	}
	return parsed.data;
}

export async function writeRuntimeState(
	paths: RuntimePaths,
	state: RuntimeState,
): Promise<void> {
	await writeFileAtomic(
		paths.state,
		`${JSON.stringify(runtimeStateSchema.parse(state))}\n`,
		0o600,
	);
}

export async function readRuntimeSettings(
	paths: RuntimePaths,
): Promise<RuntimeSettings> {
	let contents: string;
	try {
		contents = await fs.readFile(paths.settings, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT")
			return { autoUpdate: true, registry: DEFAULT_UPDATE_REGISTRY };
		throw error;
	}
	const parsed = settingsSchema.safeParse(JSON.parse(contents));
	if (!parsed.success) {
		throw new Error(
			`Iteration update settings at ${paths.settings} are invalid.`,
			{ cause: parsed.error },
		);
	}
	return parsed.data;
}

export async function writeRuntimeSettings(
	paths: RuntimePaths,
	settings: RuntimeSettings,
): Promise<void> {
	await ensureRuntimeDirectory(paths);
	await writeFileAtomic(
		paths.settings,
		`${JSON.stringify(settingsSchema.parse(settings))}\n`,
		0o600,
	);
}

class LockBusyError extends Error {}

async function tryLock(filename: string): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(filename, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`, "utf8");
			await handle.close();
			return async () => {
				const owner = await fs.readFile(filename, "utf8").catch(() => "");
				if (owner.trim() === String(process.pid))
					await fs.rm(filename, { force: true });
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const owner = Number(
				(await fs.readFile(filename, "utf8").catch(() => "")).trim(),
			);
			if (Number.isSafeInteger(owner) && owner > 1) {
				try {
					process.kill(owner, 0);
					throw new LockBusyError(`${filename} is held by process ${owner}.`);
				} catch (processError) {
					if (errorCode(processError) !== "ESRCH") throw processError;
				}
			}
			await fs.rm(filename, { force: true });
		}
	}
	throw new LockBusyError(`Could not obtain ${filename}.`);
}

// State changes are short, so writers wait briefly for each other.
export async function withRuntimeLock<T>(
	paths: RuntimePaths,
	work: () => Promise<T>,
): Promise<T> {
	await ensureRuntimeDirectory(paths);
	for (let attempt = 0; ; attempt += 1) {
		let release: () => Promise<void>;
		try {
			release = await tryLock(paths.lock);
		} catch (error) {
			if (!(error instanceof LockBusyError) || attempt >= 200) throw error;
			await delay(50);
			continue;
		}
		try {
			return await work();
		} finally {
			await release();
		}
	}
}

// Only one process downloads and installs an update; others skip the check.
export async function tryUpdateLock(
	paths: RuntimePaths,
): Promise<(() => Promise<void>) | null> {
	await ensureRuntimeDirectory(paths);
	try {
		return await tryLock(paths.updateLock);
	} catch (error) {
		if (error instanceof LockBusyError) return null;
		throw error;
	}
}

export type LaunchDecision = Readonly<{
	version: string;
	state: RuntimeState | null;
	rolledBack: Readonly<{ from: string; to: string }> | null;
}>;

// Every collector start during a trial counts against the new version until
// that source confirms a healthy pass; too many starts restore the previous
// version and reject the new one.
export function launchDecision(
	state: RuntimeState,
	command: string | undefined,
	source: string | undefined,
	nowMs: number,
): LaunchDecision {
	const trial = state.trial;
	const parsedSource = sourceSchema.safeParse(source);
	if (
		command !== "run" ||
		trial === null ||
		trial.version !== state.current ||
		!parsedSource.success ||
		trial.confirmed.includes(parsedSource.data)
	) {
		return { version: state.current, state: null, rolledBack: null };
	}
	const starts = (trial.starts[parsedSource.data] ?? 0) + 1;
	if (starts <= MAX_TRIAL_STARTS) {
		return {
			version: state.current,
			state: {
				...state,
				trial: {
					...trial,
					starts: { ...trial.starts, [parsedSource.data]: starts },
				},
			},
			rolledBack: null,
		};
	}
	return {
		version: trial.previous,
		state: {
			...state,
			current: trial.previous,
			previous: null,
			trial: null,
			rejected: [
				...state.rejected,
				{
					version: trial.version,
					reason: `The ${parsedSource.data} collector stopped ${MAX_TRIAL_STARTS} times before completing a collection pass.`,
					atMs: nowMs,
				},
			].slice(-20),
		},
		rolledBack: { from: trial.version, to: trial.previous },
	};
}

export type TrialConfirmation = Readonly<{
	state: RuntimeState;
	completed: boolean;
}> | null;

export function confirmTrialSource(
	state: RuntimeState,
	version: string,
	source: CollectorSource,
	nowMs: number,
): TrialConfirmation {
	const trial = state.trial;
	if (
		trial === null ||
		trial.version !== version ||
		state.current !== version ||
		trial.confirmed.includes(source)
	)
		return null;
	const confirmed = [...trial.confirmed, source];
	const completed = trial.expected.every((item) => confirmed.includes(item));
	return {
		state: completed
			? {
					...state,
					trial: null,
					lastUpdate: { from: trial.previous, to: version, atMs: nowMs },
				}
			: { ...state, trial: { ...trial, confirmed } },
		completed,
	};
}

function versionDirectory(paths: RuntimePaths, version: string): string {
	if (!isVersion(version))
		throw new Error(`Invalid Iteration version ${version}.`);
	return path.join(paths.versions, version);
}

export function versionEntry(
	paths: RuntimePaths,
	version: string,
	entry: "cli.js" | "cursor-hook-entry.js" | "launcher.js",
): string {
	return path.join(versionDirectory(paths, version), "dist", entry);
}

const packageSchema = z
	.object({ name: z.literal("iteration-cli"), version: versionSchema })
	.loose();

export async function readPackageVersion(root: string): Promise<string> {
	const parsed = packageSchema.safeParse(
		JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
	);
	if (!parsed.success) {
		throw new Error(`${root} does not contain an Iteration CLI package.`, {
			cause: parsed.error,
		});
	}
	return parsed.data.version;
}

// The bundled CLI and hook entries sit in `dist` next to package.json.
export function ownPackageRoot(): string {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

// Every file of an installed version must be a plain file or directory, and
// its three entries must exist, before a service may run it.
async function assertInstallablePackage(
	root: string,
	version: string,
): Promise<void> {
	const packageVersion = await readPackageVersion(root);
	if (packageVersion !== version) {
		throw new Error(
			`The downloaded package is version ${packageVersion}, not ${version}.`,
		);
	}
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop()!;
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) pending.push(filename);
			else if (!entry.isFile())
				throw new Error(
					`The package contains an unexpected entry ${filename}.`,
				);
		}
	}
	for (const entry of ["cli.js", "cursor-hook-entry.js", "launcher.js"]) {
		const stats = await fs.stat(path.join(root, "dist", entry));
		if (!stats.isFile())
			throw new Error(`The package is missing dist/${entry}.`);
	}
}

// Moves a verified package into the versions directory. A leftover directory
// from an interrupted install of the same version is replaced.
export async function installVersionDirectory(
	paths: RuntimePaths,
	staged: string,
	version: string,
): Promise<void> {
	await assertInstallablePackage(staged, version);
	const target = versionDirectory(paths, version);
	const displaced = path.join(
		paths.staging,
		`displaced-${version}-${process.pid}-${Date.now()}`,
	);
	try {
		await fs.rename(target, displaced);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	await fs.rename(staged, target);
	await fs.rm(displaced, { recursive: true, force: true });
}

export async function copyOwnPackage(
	paths: RuntimePaths,
	root: string,
	version: string,
): Promise<void> {
	await ensureRuntimeDirectory(paths);
	const staged = await fs.mkdtemp(path.join(paths.staging, `copy-${version}-`));
	try {
		const packageRoot = path.join(staged, "package");
		await fs.mkdir(packageRoot);
		await fs.copyFile(
			path.join(root, "package.json"),
			path.join(packageRoot, "package.json"),
		);
		await fs.cp(path.join(root, "dist"), path.join(packageRoot, "dist"), {
			recursive: true,
			dereference: true,
		});
		await installVersionDirectory(paths, packageRoot, version);
	} finally {
		await fs.rm(staged, { recursive: true, force: true });
	}
}

export async function pruneVersions(
	paths: RuntimePaths,
	keep: readonly string[],
): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(paths.versions);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (keep.includes(entry)) continue;
		await fs.rm(path.join(paths.versions, entry), {
			recursive: true,
			force: true,
		});
	}
}

export async function launcherMatches(
	paths: RuntimePaths,
	version: string,
): Promise<boolean> {
	try {
		const [installed, packaged] = await Promise.all([
			fs.readFile(paths.launcher),
			fs.readFile(versionEntry(paths, version, "launcher.js")),
		]);
		return installed.equals(packaged);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

export async function stageLauncher(
	paths: RuntimePaths,
	version: string,
): Promise<string> {
	const staged = path.join(
		paths.staging,
		`launcher-${version}-${process.pid}-${Date.now()}.js`,
	);
	await fs.copyFile(versionEntry(paths, version, "launcher.js"), staged);
	await fs.chmod(staged, 0o644);
	return staged;
}

export async function commitLauncher(
	paths: RuntimePaths,
	staged: string,
): Promise<void> {
	await fs.rename(staged, paths.launcher);
}

// Spreads adoption of a new release over six hours so a faulty release reaches
// a fraction of computers before it can be withdrawn.
export function rolloutDelayMs(deviceKey: string): number {
	const digest = createHash("sha256").update(deviceKey).digest();
	return (digest.readUInt32BE(0) % 360) * 60_000;
}

export function deviceRolloutKey(): string {
	return `${os.hostname()}\u0000${os.homedir()}`;
}

// Service definitions outlive a Node.js upgrade only through a path that the
// installer keeps current, such as Homebrew's /opt/homebrew/bin/node, rather
// than the versioned directory process.execPath resolves to.
export async function stableNodePath(): Promise<string> {
	const actual = await fs.realpath(process.execPath);
	const invoked = process.argv0;
	const binary = process.platform === "win32" ? "node.exe" : "node";
	const candidates = [
		...(invoked !== undefined && path.isAbsolute(invoked) ? [invoked] : []),
		...(process.env.PATH ?? "")
			.split(path.delimiter)
			.filter((directory) => path.isAbsolute(directory))
			.map((directory) => path.join(directory, binary)),
	];
	for (const candidate of candidates) {
		try {
			const resolved = await fs.realpath(candidate);
			const same =
				process.platform === "win32"
					? resolved.toLowerCase() === actual.toLowerCase()
					: resolved === actual;
			if (same) return candidate;
		} catch (error) {
			const code = errorCode(error);
			if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES")
				throw error;
		}
	}
	return process.execPath;
}
