import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as z from "zod";
import {
	CURSOR_HOOKS,
	cursorHookDirectory,
	cursorHookFailurePath,
} from "./cursor-hooks.js";
import { gitBranch, gitRepositoryUrl } from "./git-repository.js";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_QUEUE_BYTES = 256 * 1024 * 1024;
const MAX_QUEUE_FILES = 2000;
const MAX_SUBAGENT_BYTES = 64 * 1024 * 1024;
const SUBAGENT_CHUNK_BYTES = 200_000;
const hookInputSchema = z
	.object({
		conversation_id: z.string().optional(),
		parent_conversation_id: z.string().optional(),
		subagent_id: z.string().optional(),
		workspace_roots: z.array(z.string()).optional(),
		transcript_path: z.string().nullable().optional(),
		agent_transcript_path: z.string().nullable().optional(),
	})
	.loose();
type HookInput = z.infer<typeof hookInputSchema>;

async function assertQueueCapacity(
	directory: string,
	incomingBytes: number,
): Promise<void> {
	const names = (await fs.readdir(directory)).filter(
		(name) => name.endsWith(".jsonl") || name.endsWith(".tmp"),
	);
	if (names.length >= MAX_QUEUE_FILES)
		throw new Error("Cursor hook queue is full.");
	let total = incomingBytes;
	for (let start = 0; start < names.length; start += 64) {
		const sizes = await Promise.all(
			names.slice(start, start + 64).map(async (name) => {
				try {
					return (await fs.stat(path.join(directory, name))).size;
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
						return 0;
					throw error;
				}
			}),
		);
		total += sizes.reduce((sum, size) => sum + size, 0);
		if (total > MAX_QUEUE_BYTES) throw new Error("Cursor hook queue is full.");
	}
}

async function writeRecord(directory: string, value: unknown): Promise<void> {
	const serialized = `${JSON.stringify(value)}\n`;
	const recordBytes = Buffer.byteLength(serialized, "utf8");
	if (recordBytes > 12 * 1024 * 1024)
		throw new Error("Cursor hook record exceeds the capture limit.");
	await assertQueueCapacity(directory, recordBytes);
	const id = randomUUID();
	const temporary = path.join(directory, `${id}.tmp`);
	const filename = path.join(directory, `${id}.jsonl`);
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(serialized, "utf8");
		await handle.sync();
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, filename);
}

async function captureSubagentTranscript(
	directory: string,
	input: HookInput,
	capturedAt: string,
	transcriptBytes: number | null,
): Promise<void> {
	const filename = input.agent_transcript_path;
	if (filename === null || filename === undefined || !path.isAbsolute(filename))
		return;
	const stats = await fs.stat(filename);
	if (!stats.isFile() || stats.size > MAX_SUBAGENT_BYTES)
		throw new Error("Cursor subagent transcript exceeds the capture limit.");
	const contents = await fs.readFile(filename);
	const parts = Math.max(1, Math.ceil(contents.length / SUBAGENT_CHUNK_BYTES));
	const decoder = new StringDecoder("utf8");
	for (let index = 0; index < parts; index += 1) {
		const bytes = contents.subarray(
			index * SUBAGENT_CHUNK_BYTES,
			(index + 1) * SUBAGENT_CHUNK_BYTES,
		);
		const text =
			decoder.write(bytes) + (index === parts - 1 ? decoder.end() : "");
		await writeRecord(directory, {
			kind: "subagent_transcript_chunk",
			capturedAt,
			transcriptBytes,
			input: {
				conversation_id: input.conversation_id,
				parent_conversation_id: input.parent_conversation_id,
				subagent_id: input.subagent_id,
			},
			subagent: {
				path: filename,
				part: index + 1,
				totalParts: parts,
				text,
				base64: bytes.toString("base64"),
			},
		});
	}
}

async function main(): Promise<void> {
	const hook = process.argv[2];
	const dataDirectory = process.argv[3];
	if (
		!hook ||
		!CURSOR_HOOKS.includes(hook as (typeof CURSOR_HOOKS)[number]) ||
		!dataDirectory
	)
		throw new Error("Invalid Cursor hook command.");
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_INPUT_BYTES)
			throw new Error("Cursor hook input exceeds the capture limit.");
		chunks.push(buffer);
	}
	const input = hookInputSchema.parse(
		JSON.parse(Buffer.concat(chunks).toString("utf8")),
	);
	const transcriptPath = input.transcript_path ?? null;
	let transcriptBytes: number | null = null;
	if (transcriptPath !== null) {
		try {
			transcriptBytes = (await fs.stat(transcriptPath)).size;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
	}
	const directory = cursorHookDirectory(dataDirectory);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const capturedAt = new Date().toISOString();
	const cwd = input.workspace_roots?.[0] ?? null;
	const git =
		(hook === "sessionStart" || hook === "beforeSubmitPrompt") && cwd !== null
			? { branch: gitBranch(cwd), repository_url: gitRepositoryUrl(cwd) }
			: null;
	await writeRecord(directory, {
		hook,
		capturedAt,
		transcriptBytes,
		input,
		git,
	});
	if (hook === "subagentStop")
		await captureSubagentTranscript(
			directory,
			input,
			capturedAt,
			transcriptBytes,
		);
}

main()
	.catch(async (error: unknown) => {
		process.stderr.write(
			`Iteration Cursor capture failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
		);
		const dataDirectory = process.argv[3];
		if (dataDirectory) {
			try {
				await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
				const temporary = `${cursorHookFailurePath(dataDirectory)}.${randomUUID()}.tmp`;
				await fs.writeFile(
					temporary,
					`${JSON.stringify({ atMs: Date.now() })}\n`,
					{ mode: 0o600 },
				);
				await fs.rename(temporary, cursorHookFailurePath(dataDirectory));
			} catch (statusError) {
				process.stderr.write(
					`Iteration could not save the Cursor capture failure: ${statusError instanceof Error ? statusError.message : "unknown error"}\n`,
				);
			}
		}
		process.exitCode = 1;
	})
	.finally(() => {
		process.stdout.write(
			process.argv[2] === "preToolUse" || process.argv[2] === "subagentStart"
				? '{"permission":"allow"}\n'
				: process.argv[2] === "beforeSubmitPrompt"
					? '{"continue":true}\n'
					: "{}\n",
		);
	});
