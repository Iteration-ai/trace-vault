import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod";

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
