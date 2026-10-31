import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateDirectory } from "./private-storage.js";
import type { CollectorPaths } from "./storage.js";

function errorCode(error: unknown): string | null {
	if (error instanceof Error && "code" in error) return String(error.code);
	return null;
}

class CollectorLockBusyError extends Error {}

export async function acquireCollectorLock(
	paths: CollectorPaths,
): Promise<() => Promise<void>> {
	await ensurePrivateDirectory(path.dirname(paths.lock));
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(paths.lock, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`, "utf8");
			await handle.sync();
			await handle.close();
			return async () => {
				const current = await fs.readFile(paths.lock, "utf8").catch(() => "");
				if (current.trim() === String(process.pid)) {
					await fs.rm(paths.lock, { force: true });
				}
			};
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const lockContents = await fs
				.readFile(paths.lock, "utf8")
				.catch(() => "");
			const lockPid = Number(lockContents.trim());
			if (!Number.isSafeInteger(lockPid) || lockPid < 2) {
				await fs.rm(paths.lock, { force: true });
				continue;
			}
			try {
				process.kill(lockPid, 0);
				throw new CollectorLockBusyError("Collector is already running.");
			} catch (processError) {
				if (errorCode(processError) !== "ESRCH") throw processError;
				await fs.rm(paths.lock, { force: true });
			}
		}
	}
	throw new Error("Could not obtain the collector lock.");
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
