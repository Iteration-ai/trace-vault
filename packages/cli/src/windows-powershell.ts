import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import * as z from "zod";

const execFile = promisify(execFileCallback);

export function windowsPowerShellPath(): string {
	return path.join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
}

export function powershellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function encodedPowerShell(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

export async function runWindowsPowerShell(
	operation: string,
	script: string,
): Promise<string> {
	// A PowerShell 7 parent passes incompatible module paths through Node.
	// Let Windows PowerShell 5.1 reconstruct its own defaults at startup.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => name.toLowerCase() !== "psmodulepath",
		),
	);
	try {
		const { stdout } = await execFile(
			windowsPowerShellPath(),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				encodedPowerShell(
					`$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${script}`,
				),
			],
			{
				env,
				timeout: 30_000,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			},
		);
		return stdout.trim();
	} catch (error) {
		const failure = z.object({ stderr: z.string() }).safeParse(error);
		const detail = failure.success
			? failure.data.stderr.trim().slice(0, 4096)
			: "";
		throw new Error(
			`Windows could not ${operation}.${detail ? `\n${detail}` : ""}`,
			{ cause: error },
		);
	}
}

// ProcessStartInfo parses a Windows argument vector, without a shell or
// environment expansion. Trailing backslashes must survive the closing quote.
export function windowsArgument(value: string): string {
	return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function windowsHookInvocation(
	nodePath: string,
	args: readonly string[],
): string {
	const script = `$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n& ${[nodePath, ...args].map(powershellLiteral).join(" ")}\nexit $LASTEXITCODE`;
	return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedPowerShell(script)}`;
}

export function windowsHookArguments(command: string): string | null {
	const encoded =
		/^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(
			command,
		)?.[1];
	return encoded === undefined
		? null
		: Buffer.from(encoded, "base64").toString("utf16le");
}
