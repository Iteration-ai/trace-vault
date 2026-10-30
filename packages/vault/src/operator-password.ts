import { fstatSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";

const MAX_PASSWORD_BYTES = 2048;

export class OperatorInputError extends Error {}

function privatePrompt(prompt: string): Promise<string> {
	const input = process.stdin;
	const wasRaw = input.isRaw;
	emitKeypressEvents(input);
	input.setRawMode(true);
	input.resume();
	return new Promise<string>((resolve, reject) => {
		let value = "";
		const finish = (error?: Error) => {
			clearTimeout(timer);
			input.off("keypress", keypress);
			input.off("end", ended);
			input.off("error", ended);
			process.off("SIGTERM", ended);
			process.off("SIGINT", ended);
			input.setRawMode(wasRaw);
			input.pause();
			process.stderr.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const ended = () =>
			finish(new OperatorInputError("Password input cancelled."));
		const keypress = (
			text: string | undefined,
			key: { name?: string; ctrl?: boolean; meta?: boolean },
		) => {
			if (key.ctrl && ["c", "d"].includes(key.name ?? "")) return ended();
			if (key.name === "return" || key.name === "enter") return finish();
			if (key.name === "backspace") value = [...value].slice(0, -1).join("");
			else if (!key.ctrl && !key.meta && text && !/[\p{Cc}\p{Cf}]/u.test(text))
				value += text;
			if (Buffer.byteLength(value) > MAX_PASSWORD_BYTES)
				finish(new OperatorInputError("Password input is too long."));
		};
		const timer = setTimeout(
			() => finish(new OperatorInputError("Password input timed out.")),
			300_000,
		);
		input.on("keypress", keypress);
		input.once("end", ended);
		input.once("error", ended);
		process.once("SIGTERM", ended);
		process.once("SIGINT", ended);
		process.stderr.write(prompt);
	});
}

export async function readOperatorPassword(
	fromStdin: boolean,
): Promise<string> {
	if (!fromStdin) {
		if (!process.stdin.isTTY || !process.stderr.isTTY)
			throw new OperatorInputError(
				"Use a private terminal, or --password-stdin with protected input.",
			);
		const password = await privatePrompt("New password (hidden): ");
		const confirmation = await privatePrompt("Confirm password (hidden): ");
		if (password !== confirmation)
			throw new OperatorInputError("Passwords do not match; nothing changed.");
		return password;
	}
	const input = process.stdin;
	const metadata = fstatSync(input.fd);
	if (
		input.isTTY ||
		!(metadata.isFile() || metadata.isFIFO()) ||
		(metadata.mode & 0o077) !== 0 ||
		metadata.uid !== process.getuid?.()
	)
		throw new OperatorInputError(
			"Password stdin must be an owner-only file or pipe owned by this operator (0600).",
		);
	const chunks: Buffer[] = [];
	let bytes = 0;
	const timer = setTimeout(
		() => input.destroy(new OperatorInputError("Password input timed out.")),
		60_000,
	);
	try {
		for await (const chunk of input) {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += data.length;
			if (bytes > MAX_PASSWORD_BYTES)
				throw new OperatorInputError("Password input is too long.");
			chunks.push(data);
		}
		const password = new TextDecoder("utf-8", { fatal: true })
			.decode(Buffer.concat(chunks))
			.replace(/\r?\n$/, "");
		if (/[\r\n\0]/.test(password))
			throw new OperatorInputError("Supply exactly one password on stdin.");
		return password;
	} finally {
		clearTimeout(timer);
		for (const chunk of chunks) chunk.fill(0);
	}
}
