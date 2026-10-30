import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { CollectorSource } from "iteration-trace-contracts";
import { ensurePrivateDirectory } from "./private-storage.js";
import { runtimePaths } from "./runtime.js";
import { windowsLogPath, windowsOutputPath } from "./task-scheduler.js";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const RESTART_DELAY_MS = 5_000;

async function appendLog(filename: string, bytes: Buffer): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const size = await fs
			.stat(filename)
			.then((stat) => stat.size)
			.catch((error: unknown) => {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return 0;
				throw error;
			});
		if (size >= MAX_LOG_BYTES) {
			await fs.rm(`${filename}.1`, { force: true });
			await fs.rename(filename, `${filename}.1`);
			continue;
		}
		const count = Math.min(bytes.length - offset, MAX_LOG_BYTES - size);
		await fs.appendFile(filename, bytes.subarray(offset, offset + count), {
			mode: 0o600,
		});
		offset += count;
	}
}

async function copyOutput(stream: Readable, filename: string): Promise<void> {
	for await (const chunk of stream) {
		if (!Buffer.isBuffer(chunk))
			throw new Error("Collector output was not a byte stream.");
		await appendLog(filename, chunk);
	}
}

export async function superviseCollector(
	source: CollectorSource,
	dataDirectory: string,
): Promise<void> {
	const output = windowsOutputPath(source);
	const errors = windowsLogPath(source);
	await ensurePrivateDirectory(path.dirname(output));
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		while (!controller.signal.aborted) {
			const child = spawn(
				process.execPath,
				[
					runtimePaths().launcher,
					"run",
					source,
					"--data-directory",
					dataDirectory,
				],
				{
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			let spawnError: Error | null = null;
			child.once("error", (error) => {
				spawnError = error;
			});
			const closed = new Promise<number | null>((resolve) =>
				child.once("close", resolve),
			);
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const terminate = () => {
				child.kill();
				killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
				killTimer.unref();
			};
			controller.signal.addEventListener("abort", terminate, { once: true });
			if (controller.signal.aborted) terminate();
			const drain = (stream: Readable, filename: string) =>
				copyOutput(stream, filename).catch((error: unknown) => {
					child.kill("SIGKILL");
					throw error;
				});
			const results = await Promise.allSettled([
				closed,
				drain(child.stdout, output),
				drain(child.stderr, errors),
			]);
			controller.signal.removeEventListener("abort", terminate);
			clearTimeout(killTimer);
			for (const result of results)
				if (result.status === "rejected") throw result.reason;
			if (controller.signal.aborted) break;
			await appendLog(
				errors,
				Buffer.from(
					`${JSON.stringify({ level: "warning", operation: "collector_restart", source, exitCode: child.exitCode, error: spawnError === null ? null : String(spawnError), at: new Date().toISOString() })}\n`,
				),
			);
			await delay(RESTART_DELAY_MS, undefined, {
				signal: controller.signal,
			}).catch((error: unknown) => {
				if (!controller.signal.aborted) throw error;
			});
		}
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
	}
}
