import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { on, once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
	acquireCollectorLock,
	collectorPaths,
	waitForCollectorLock,
} from "./index.js";

async function fixture(context: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "collector-lock-test-"));
	const processes: { stop: () => Promise<void> }[] = [];
	context.after(async () => {
		await Promise.all(processes.map((child) => child.stop()));
		await fs.rm(root, { recursive: true, force: true });
	});
	const paths = collectorPaths(root);
	return {
		paths,
		async start(mode = "normal") {
			const child = spawn(
				process.execPath,
				[
					"--import=tsx",
					"--input-type=module",
					"--eval",
					`
import { promises as fs } from "node:fs";
import { acquireCollectorLock, collectorPaths } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
const paths = collectorPaths(${JSON.stringify(root)});
const mode = ${JSON.stringify(mode)};
if (mode === "pid1" || mode === "reused-pid") Object.defineProperty(process, "pid", { value: mode === "pid1" ? 1 : process.ppid });
const message = () => new Promise(resolve => process.once("message", resolve));
const pause = async () => { process.send({ type: "paused" }); await message(); };
const open = fs.open.bind(fs);
fs.open = async (...args) => {
  const handle = await open(...args);
  if (mode === "initialize" && args[0] === paths.lock && args[1] === "wx") await pause();
  return handle;
};
const link = fs.link.bind(fs);
fs.link = async (...args) => {
  if (mode === "initialize" && args[1] === paths.lock) await pause();
  return link(...args);
};
const rm = fs.rm.bind(fs);
let paused = false;
fs.rm = async (...args) => {
  if (mode === "recover" && args[0] === paths.lock && !paused) { paused = true; await pause(); }
  return rm(...args);
};
process.send({ type: "ready" });
await message();
try {
  const release = await acquireCollectorLock(paths);
  process.send({ type: "acquired" });
  await message();
  await release();
  process.send({ type: "released" });
} catch (error) {
  process.send({ type: "rejected", message: error.message });
}
process.disconnect();
`,
				],
				{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
			);
			const messages = on(child, "message", { signal: context.signal });
			const exited = once(child, "exit");
			let errors = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				errors += chunk.toString();
			});
			const worker = {
				child,
				async next() {
					const result = await messages.next();
					assert.ok(!result.done, errors);
					const [value] = result.value as unknown[];
					assert.ok(
						value && typeof value === "object" && "type" in value,
						errors,
					);
					return value as { type: string; message?: string };
				},
				async stop() {
					if (child.exitCode === null && child.signalCode === null)
						child.kill("SIGKILL");
					await exited;
					await messages.return?.();
				},
			};
			processes.push(worker);
			assert.equal((await worker.next()).type, "ready");
			child.send("start");
			return worker;
		},
	};
}

for (const phase of ["initialize", "recover"]) {
	test(`only one process owns the collector during ${phase}`, {
		timeout: 30_000,
	}, async (context) => {
		const f = await fixture(context);
		if (phase === "recover") {
			const stale = await f.start();
			assert.equal((await stale.next()).type, "acquired");
			await stale.stop();
		}
		const owner = await f.start(phase);
		assert.equal((await owner.next()).type, "paused");
		const contender = await f.start();
		const result = await contender.next();
		assert.equal(result.type, "rejected");
		assert.match(result.message ?? "", /already running/);
		owner.child.send("continue");
		assert.equal((await owner.next()).type, "acquired");
		owner.child.send("release");
		assert.equal((await owner.next()).type, "released");
		const release = await waitForCollectorLock(f.paths);
		await release();
	});
}

test("a rejected same-process contender cannot unlock another process, and a killed owner recovers immediately", {
	timeout: 30_000,
}, async (context) => {
	const f = await fixture(context);
	const release = await acquireCollectorLock(f.paths);
	try {
		await assert.rejects(acquireCollectorLock(f.paths), /already running/);
		const contender = await f.start();
		assert.equal((await contender.next()).type, "rejected");
	} finally {
		await release();
	}
	const owner = await f.start();
	assert.equal((await owner.next()).type, "acquired");
	await owner.stop();
	const recovered = await acquireCollectorLock(f.paths);
	await recovered();
});

test("releasing an old handle twice cannot remove a later owner's lock", {
	timeout: 30_000,
}, async (context) => {
	const f = await fixture(context);
	const first = await acquireCollectorLock(f.paths);
	await first();
	const second = await acquireCollectorLock(f.paths);
	try {
		await first();
		await assert.rejects(acquireCollectorLock(f.paths), /already running/);
		const contender = await f.start();
		assert.equal((await contender.next()).type, "rejected");
	} finally {
		await second();
	}
});

test("legacy live or incomplete locks fail closed without leaking the new lock", {
	timeout: 30_000,
}, async (context) => {
	const f = await fixture(context);
	for (const contents of [`${process.pid}\n`, ""]) {
		await fs.writeFile(f.paths.lock, contents);
		await assert.rejects(
			acquireCollectorLock(f.paths),
			/already running|uninitialized or invalid/,
		);
		assert.equal(await fs.readFile(f.paths.lock, "utf8"), contents);
		await fs.rm(f.paths.lock);
		const release = await acquireCollectorLock(f.paths);
		await release();
	}
});

test("failed marker publication releases ownership for a retry", async (context) => {
	const f = await fixture(context);
	const link = fs.link.bind(fs);
	let failed = false;
	context.mock.method(
		fs,
		"link",
		async (...args: Parameters<typeof fs.link>) => {
			if (!failed) {
				failed = true;
				throw new Error("Marker publication failed.");
			}
			return link(...args);
		},
	);
	await assert.rejects(
		acquireCollectorLock(f.paths),
		/Marker publication failed/,
	);
	const release = await acquireCollectorLock(f.paths);
	await release();
});

for (const mode of ["pid1", "reused-pid"]) {
	test(`a crashed ${mode} owner recovers without trusting a live numeric PID`, {
		timeout: 30_000,
	}, async (context) => {
		const f = await fixture(context);
		const owner = await f.start(mode);
		assert.equal((await owner.next()).type, "acquired");
		await owner.stop();
		const release = await acquireCollectorLock(f.paths);
		await release();
	});
}

for (const suffix of ["", ".owner"]) {
	test(`failed ${suffix || "PID-marker"} removal retains ownership until release retries successfully`, async (context) => {
		const f = await fixture(context);
		const release = await acquireCollectorLock(f.paths);
		const remove = fs.rm.bind(fs);
		let failed = false;
		context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
			if (!failed && args[0] === `${f.paths.lock}${suffix}`) {
				failed = true;
				throw new Error("Marker removal failed.");
			}
			return remove(...args);
		});
		try {
			await assert.rejects(release(), /Marker removal failed/);
			await assert.rejects(acquireCollectorLock(f.paths), /already running/);
			await release();
			const next = await acquireCollectorLock(f.paths);
			try {
				await release();
				await assert.rejects(acquireCollectorLock(f.paths), /already running/);
			} finally {
				await next();
			}
		} finally {
			await release();
		}
	});
}
