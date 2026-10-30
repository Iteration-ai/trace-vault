import { ensurePrivateDirectory } from "./private-storage.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod";
import { gitBranch, gitRepositoryUrl } from "./git-repository.js";

export function claudeGitHookPaths(dataDirectory: string): Readonly<{
	script: string;
	queue: string;
	failure: string;
}> {
	return {
		script: path.join(dataDirectory, "claude-git", "session-start-hook.sh"),
		queue: path.join(dataDirectory, "claude-git", "git-queue"),
		failure: path.join(dataDirectory, "claude-git", "failure.json"),
	};
}

const startInput = z.object({
	hook_event_name: z.literal("SessionStart"),
	session_id: z.uuid(),
	cwd: z.string().min(1),
});

export async function captureClaudeGit(dataDirectory: string): Promise<void> {
	let inputText = "";
	for await (const chunk of process.stdin) {
		inputText += chunk.toString();
		if (inputText.length > 64_000)
			throw new Error("Claude start hook input is too large.");
	}
	const input = startInput.parse(JSON.parse(inputText));
	if (!path.isAbsolute(input.cwd))
		throw new Error("Claude start hook cwd is not absolute.");
	const git = {
		branch: gitBranch(input.cwd),
		repository_url: gitRepositoryUrl(input.cwd),
	};
	if (git.branch === null && git.repository_url === null) {
		process.stdout.write("{}\n");
		return;
	}
	const directory = claudeGitHookPaths(dataDirectory).queue;
	await ensurePrivateDirectory(directory);
	const files = (await fs.readdir(directory)).filter((name) =>
		name.endsWith(".jsonl"),
	);
	if (files.length >= 10_000) throw new Error("Claude Git hook queue is full.");
	const name = randomUUID();
	const temporary = path.join(directory, `${name}.tmp`);
	const filename = path.join(directory, `${name}.jsonl`);
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(
				`${JSON.stringify({ sessionId: input.session_id, cwd: input.cwd, git, capturedAt: new Date().toISOString() })}\n`,
			);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, filename);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
	process.stdout.write("{}\n");
}

export async function claudeGitHookFiles(
	dataDirectory: string,
): Promise<string[]> {
	const directory = claudeGitHookPaths(dataDirectory).queue;
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	if (names.length > 10_000)
		throw new Error("Claude Git hook queue exceeds the scan limit.");
	return names
		.filter((name) => /^[0-9a-f-]+\.jsonl$/i.test(name))
		.sort()
		.map((name) => path.join(directory, name));
}

export async function recordClaudeGitHookFailure(
	dataDirectory: string,
): Promise<void> {
	const filename = claudeGitHookPaths(dataDirectory).failure;
	await ensurePrivateDirectory(path.dirname(filename));
	const temporary = `${filename}.${randomUUID()}.tmp`;
	await fs.writeFile(temporary, `${JSON.stringify({ atMs: Date.now() })}\n`, {
		mode: 0o600,
	});
	await fs.rename(temporary, filename);
}

export async function claudeGitHookFailureAtMs(
	dataDirectory: string,
): Promise<number | null> {
	let contents: string;
	try {
		contents = await fs.readFile(
			claudeGitHookPaths(dataDirectory).failure,
			"utf8",
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(contents);
	} catch (error) {
		throw new Error("Claude Git hook failure status is invalid.", {
			cause: error,
		});
	}
	const parsed = z.object({ atMs: z.number().int().min(0) }).safeParse(decoded);
	if (!parsed.success)
		throw new Error("Claude Git hook failure status is invalid.");
	return parsed.data.atMs;
}
