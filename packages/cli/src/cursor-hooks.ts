import { ensurePrivateDirectory } from "./private-storage.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod";
import { runtimePaths, stableNodePath } from "./runtime.js";
import {
	powershellLiteral,
	windowsHookArguments,
	windowsHookInvocation,
} from "./windows-powershell.js";

export const CURSOR_HOOKS = [
	"sessionStart",
	"beforeSubmitPrompt",
	"preToolUse",
	"postToolUse",
	"postToolUseFailure",
	"afterAgentThought",
	"afterAgentResponse",
	"preCompact",
	"stop",
	"subagentStart",
	"subagentStop",
	"sessionEnd",
] as const;

export function cursorHookDirectory(dataDirectory: string): string {
	return path.join(dataDirectory, "cursor-hooks");
}

export function cursorHookFailurePath(dataDirectory: string): string {
	return path.join(dataDirectory, "cursor-hook-failure.json");
}

export async function cursorHookFailureAtMs(
	dataDirectory: string,
): Promise<number | null> {
	let contents: string;
	try {
		contents = await fs.readFile(cursorHookFailurePath(dataDirectory), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error("Cursor hook failure status is invalid.", { cause: error });
	}
	const parsed = z
		.object({ atMs: z.number().int().min(0) })
		.strict()
		.safeParse(decoded);
	if (!parsed.success)
		throw new Error("Cursor hook failure status is invalid.");
	return parsed.data.atMs;
}

function shellQuote(value: string): string {
	if (process.platform === "win32") return `"${value}"`;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hookCommand(
	nodePath: string,
	hook: string,
	dataDirectory: string,
): string {
	if (process.platform === "win32")
		return windowsHookInvocation(nodePath, [
			runtimePaths().launcher,
			"cursor-hook",
			hook,
			dataDirectory,
		]);
	return `${shellQuote(nodePath)} ${shellQuote(runtimePaths().launcher)} cursor-hook ${shellQuote(hook)} ${shellQuote(dataDirectory)}`;
}

// Earlier releases ran their own cursor-hook-entry.js; an entry is Iteration's
// when it runs either entry for this hook and data directory.
function isIterationHook(
	command: string | undefined,
	hook: string,
	dataDirectory: string,
): boolean {
	if (process.platform === "win32" && command !== undefined) {
		const invocation = windowsHookArguments(command);
		if (invocation !== null)
			return (
				invocation.includes("\n& '") &&
				invocation.endsWith(
					` ${[runtimePaths().launcher, "cursor-hook", hook, dataDirectory].map(powershellLiteral).join(" ")}\nexit $LASTEXITCODE`,
				)
			);
	}
	return (
		command !== undefined &&
		command.endsWith(` ${shellQuote(hook)} ${shellQuote(dataDirectory)}`) &&
		(command.includes("cursor-hook-entry.js") ||
			command.includes(`${shellQuote(runtimePaths().launcher)} cursor-hook `))
	);
}

const hookEntrySchema = z.object({ command: z.string().optional() }).loose();
const hookFileSchema = z
	.object({
		version: z.literal(1).optional(),
		hooks: z.record(z.string(), z.array(hookEntrySchema)).optional(),
	})
	.loose();
type HookEntry = z.infer<typeof hookEntrySchema>;
type HookFile = z.infer<typeof hookFileSchema>;

async function readHooks(
	filename: string,
): Promise<Readonly<{ file: HookFile; mode: number }>> {
	let contents: string;
	let mode = 0o600;
	try {
		contents = await fs.readFile(filename, "utf8");
		mode = (await fs.stat(filename)).mode & 0o777;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { file: {}, mode };
		throw new Error(`Could not read Cursor hooks at ${filename}.`, {
			cause: error,
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Cursor hooks at ${filename} are not valid JSON.`, {
			cause: error,
		});
	}
	const checked = hookFileSchema.safeParse(parsed);
	if (!checked.success)
		throw new Error(`Cursor hooks at ${filename} have an unexpected shape.`);
	return { file: checked.data, mode };
}

async function writeHooks(
	filename: string,
	file: HookFile,
	mode: number,
): Promise<void> {
	await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
	const target = await fs.realpath(filename).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return filename;
		throw error;
	});
	const temporary = `${target}.iteration-${process.pid}.tmp`;
	const handle = await fs.open(temporary, "w", mode);
	try {
		await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, target);
}

function entries(value: HookEntry[] | undefined): HookEntry[] {
	return value ?? [];
}

export async function installCursorHooks(
	cursorHome: string,
	dataDirectory: string,
): Promise<void> {
	await ensurePrivateDirectory(cursorHookDirectory(dataDirectory));
	const filename = path.join(cursorHome, "hooks.json");
	const { file, mode } = await readHooks(filename);
	const hooks = { ...file.hooks };
	const nodePath = await stableNodePath();
	for (const hook of CURSOR_HOOKS) {
		const command = hookCommand(nodePath, hook, dataDirectory);
		const others = entries(hooks[hook]).filter(
			(entry) => !isIterationHook(entry.command, hook, dataDirectory),
		);
		hooks[hook] = [...others, { command }];
	}
	await writeHooks(filename, { ...file, version: 1, hooks }, mode);
}

export async function uninstallCursorHooks(
	cursorHome: string,
	dataDirectory: string,
): Promise<void> {
	const filename = path.join(cursorHome, "hooks.json");
	const { file, mode } = await readHooks(filename);
	const hooks = { ...file.hooks };
	let changed = false;
	for (const hook of CURSOR_HOOKS) {
		const existing = entries(hooks[hook]);
		const remaining = existing.filter(
			(entry) => !isIterationHook(entry.command, hook, dataDirectory),
		);
		if (remaining.length !== existing.length) {
			changed = true;
			if (remaining.length === 0) delete hooks[hook];
			else hooks[hook] = remaining;
		}
	}
	if (changed) await writeHooks(filename, { ...file, hooks }, mode);
}

export async function cursorHookFiles(
	dataDirectory: string,
): Promise<string[]> {
	const directory = cursorHookDirectory(dataDirectory);
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	if (names.length > 10_000)
		throw new Error("Cursor hook queue exceeds the scan limit.");
	return names
		.filter((name) => /^[0-9a-f-]+\.jsonl$/i.test(name))
		.sort()
		.map((name) => path.join(directory, name));
}
