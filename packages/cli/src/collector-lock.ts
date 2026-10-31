import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateDirectory } from "./private-storage.js";
import type { CollectorPaths } from "./storage.js";

function errorCode(error: unknown): string | null {
	if (error instanceof Error && "code" in error) return String(error.code);
	return null;
}

async function lockIdentity(filename: string): Promise<string | null> {
	try {
		const stat = await fs.stat(filename, { bigint: true });
		return `${stat.dev}:${stat.ino}`;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		return null;
	}
}

class CollectorLockBusyError extends Error {}

export async function acquireCollectorLock(
	paths: CollectorPaths,
): Promise<() => Promise<void>> {
	await ensurePrivateDirectory(path.dirname(paths.lock));
	const databasePath = `${paths.lock}.sqlite`;
	const ownerPath = `${paths.lock}.owner`;
	const { DatabaseSync } = await import("node:sqlite");
	let database: DatabaseSync | undefined;
	try {
		database = new DatabaseSync(databasePath);
		// Never unlink this database: SQLite's kernel lock serializes PID-marker
		// initialization, stale recovery and release, and survives process pauses.
		database.exec("BEGIN EXCLUSIVE");
		if (process.platform !== "win32") await fs.chmod(databasePath, 0o600);
		const marker = await lockIdentity(paths.lock);
		if (marker !== null) {
			// A surviving hard link proves this marker used the SQLite guard. Its
			// owner is gone even if the PID was reused (including container PID 1).
			if (marker !== (await lockIdentity(ownerPath))) {
				const contents = await fs.readFile(paths.lock, "utf8");
				const pid = Number(contents.trim());
				if (!Number.isSafeInteger(pid) || pid < 1) {
					throw new CollectorLockBusyError(
						"Collector lock is uninitialized or invalid. Stop older collectors before removing collector.lock.",
					);
				}
				try {
					process.kill(pid, 0);
					throw new CollectorLockBusyError("Collector is already running.");
				} catch (error) {
					if (errorCode(error) !== "ESRCH") throw error;
				}
			}
			await fs.rm(paths.lock, { force: true });
		}
		await fs.rm(ownerPath, { force: true });
		await fs.writeFile(ownerPath, `${process.pid}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await fs.link(ownerPath, paths.lock);
		const owner = database;
		let released = false;
		let cleanup: Promise<void> | undefined;
		return () => {
			if (released) return Promise.resolve();
			cleanup ??= (async () => {
				try {
					await fs.rm(paths.lock, { force: true });
					await fs.rm(ownerPath, { force: true });
					owner.close();
					released = true;
				} finally {
					cleanup = undefined;
				}
			})();
			return cleanup;
		};
	} catch (error) {
		database?.close();
		if (
			errorCode(error) === "EEXIST" ||
			(error instanceof Error && "errcode" in error && error.errcode === 5)
		) {
			throw new CollectorLockBusyError("Collector is already running.", {
				cause: error,
			});
		}
		throw error;
	}
}

export async function waitForCollectorLock(
	paths: CollectorPaths,
): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 81; attempt += 1) {
		try {
			return await acquireCollectorLock(paths);
		} catch (error) {
			if (!(error instanceof CollectorLockBusyError)) throw error;
			if (attempt === 80) {
				throw new Error(
					"Collector did not stop within 20 seconds; history was not changed.",
					{ cause: error },
				);
			}
			await delay(250);
		}
	}
	throw new Error("Could not obtain the collector lock.");
}
