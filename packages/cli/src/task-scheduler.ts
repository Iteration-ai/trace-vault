import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { CollectorSource } from "iteration-trace-contracts";
import * as z from "zod";
import { ensurePrivateDirectory } from "./private-storage.js";
import { runtimePaths, stableNodePath } from "./runtime.js";
import { windowsJobDefinition } from "./windows-job.js";
import {
	encodedPowerShell,
	powershellLiteral,
	runWindowsPowerShell,
	windowsArgument,
	windowsPowerShellPath,
} from "./windows-powershell.js";

const execFile = promisify(execFileCallback);
const TASK_TIMEOUT_MS = 10_000;

export type WindowsTask = Readonly<{
	source: CollectorSource;
	userSid: string;
	nodePath: string;
	launcher: string;
	dataDirectory: string;
	home: string;
}>;

let userSid: Promise<string> | undefined;
async function currentUserSid(): Promise<string> {
	userSid ??= runWindowsPowerShell(
		"identify the collector account",
		"[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
	)
		.then((value) => {
			if (!/^S-1-\d+(?:-\d+)+$/.test(value))
				throw new Error("Windows returned an invalid collector account SID.");
			return value;
		})
		.catch((error: unknown) => {
			userSid = undefined;
			throw error;
		});
	return userSid;
}

export function scheduledTaskName(
	source: CollectorSource,
	sid: string,
): string {
	return `iteration-${sid}-${source}-collector`;
}

function servicesDirectory(): string {
	return path.join(os.homedir(), ".config", "iteration", "services");
}

export function taskDefinitionPath(source: CollectorSource): string {
	return path.join(servicesDirectory(), `iteration-${source}-collector.xml`);
}

export function windowsLogPath(source: CollectorSource): string {
	return path.join(
		os.homedir(),
		".config",
		"iteration",
		"logs",
		`iteration-${source}-collector.error.log`,
	);
}

export function windowsOutputPath(source: CollectorSource): string {
	return path.join(
		os.homedir(),
		".config",
		"iteration",
		"logs",
		`iteration-${source}-collector.log`,
	);
}

export function scheduledTaskScript(task: WindowsTask): string {
	const args = [
		task.launcher,
		"supervise",
		task.source,
		"--data-directory",
		task.dataDirectory,
	]
		.map(windowsArgument)
		.join(" ");
	const errorLog = path.join(
		task.home,
		".config",
		"iteration",
		"logs",
		`iteration-${task.source}-collector.error.log`,
	);
	return `$ErrorActionPreference = 'Stop'
try {
  $env:USERPROFILE = ${powershellLiteral(task.home)}
  $env:HOME = ${powershellLiteral(task.home)}
  Add-Type -TypeDefinition @'
${windowsJobDefinition}
'@
  $jobHandle = [IterationProcessJob]::OwnProcessTree()
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = ${powershellLiteral(task.nodePath)}
  $start.Arguments = ${powershellLiteral(args)}
  $start.WorkingDirectory = ${powershellLiteral(task.home)}
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  [IterationProcessJob]::RunSupervisor($start)
  exit 0
} catch {
  $log = ${powershellLiteral(errorLog)}
  $message = "Windows collector supervisor failed: " + $_.Exception.Message + [Environment]::NewLine
  if ([System.IO.File]::Exists($log) -and ([System.IO.FileInfo]::new($log)).Length + [System.Text.Encoding]::UTF8.GetByteCount($message) -gt 8388608) {
    [System.IO.File]::Delete($log + '.1')
    [System.IO.File]::Move($log, $log + '.1')
  }
  [System.IO.File]::AppendAllText($log, $message)
  throw
}
`;
}

function taskArguments(task: WindowsTask): string {
	return `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedPowerShell(scheduledTaskScript(task))}`;
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function scheduledTaskXml(task: WindowsTask): string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Iteration ${task.source} collector</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(task.userSid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(task.userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>9999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>${xmlEscape(windowsPowerShellPath())}</Command>
    <Arguments>${xmlEscape(taskArguments(task))}</Arguments>
    <WorkingDirectory>${xmlEscape(task.home)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

const observedTaskSchema = z
	.object({
		state: z.number().int().min(0).max(4),
		executable: z.string().max(4096),
		arguments: z.string().max(32768),
		workingDirectory: z.string().max(4096),
		userSid: z.string().max(256),
		logonUserSid: z.string().max(256),
		logonType: z.string().max(64),
		runLevel: z.string().max(64),
	})
	.strict()
	.nullable();

async function observedTask(source: CollectorSource) {
	const name = scheduledTaskName(source, await currentUserSid());
	const output = await runWindowsPowerShell(
		`query the ${source} collector task`,
		`
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
try { $task = $scheduler.GetFolder('\\').GetTask(${powershellLiteral(name)}) }
catch {
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  if ($failure.HResult -eq -2147024894) { Write-Output 'null'; exit 0 }
  throw
}
$xml = [xml]$task.Xml
function AccountSid([string]$account) {
  if (!$account -or $account -match '^S-1-\\d+(?:-\\d+)+$') { return $account }
  return ([System.Security.Principal.NTAccount]::new($account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
}
[pscustomobject]@{
  state = [int]$task.State
  executable = [string]$xml.Task.Actions.Exec.Command
  arguments = [string]$xml.Task.Actions.Exec.Arguments
  workingDirectory = [string]$xml.Task.Actions.Exec.WorkingDirectory
  userSid = AccountSid ([string]$xml.Task.Principals.Principal.UserId)
  logonUserSid = AccountSid ([string]$xml.Task.Triggers.LogonTrigger.UserId)
  logonType = [string]$xml.Task.Principals.Principal.LogonType
  runLevel = if ($task.Definition.Principal.RunLevel -eq 0) { 'LeastPrivilege' } else { 'HighestAvailable' }
} | ConvertTo-Json -Compress
`,
	);
	const parsed = observedTaskSchema.safeParse(JSON.parse(output));
	if (!parsed.success)
		throw new Error(`Windows returned an invalid ${source} collector task.`);
	return parsed.data;
}

async function schtasks(
	source: CollectorSource,
	operation: "/Create" | "/End" | "/Run" | "/Delete",
	...args: string[]
): Promise<void> {
	try {
		await execFile(
			path.join(
				process.env.SystemRoot ?? "C:\\Windows",
				"System32",
				"schtasks.exe",
			),
			[
				operation,
				"/TN",
				scheduledTaskName(source, await currentUserSid()),
				...args,
			],
			{ timeout: TASK_TIMEOUT_MS, windowsHide: true },
		);
	} catch (error) {
		const failure = z.object({ stderr: z.string() }).safeParse(error);
		const detail = failure.success
			? failure.data.stderr.trim().slice(0, 4096)
			: "";
		throw new Error(
			`Windows could not ${operation.slice(1).toLowerCase()} the ${source} collector task.${detail ? `\n${detail}` : ""}`,
			{ cause: error },
		);
	}
}

async function stopTask(source: CollectorSource): Promise<void> {
	const task = await observedTask(source);
	if (task === null || task.state === 1 || task.state === 3) return;
	await schtasks(source, "/End");
	const deadline = Date.now() + TASK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = await observedTask(source);
		if (current === null || current.state === 1 || current.state === 3) return;
		await delay(100);
	}
	throw new Error(`Windows did not stop the ${source} collector task.`);
}

async function desiredTask(
	dataDirectory: string,
	source: CollectorSource,
): Promise<WindowsTask> {
	return {
		source,
		dataDirectory,
		userSid: await currentUserSid(),
		nodePath: await stableNodePath(),
		launcher: runtimePaths().launcher,
		home: os.homedir(),
	};
}

export async function scheduledTaskUsesRuntime(
	dataDirectory: string,
	source: CollectorSource,
): Promise<boolean> {
	const actual = await observedTask(source);
	if (actual === null) return false;
	const desired = await desiredTask(dataDirectory, source);
	return (
		actual.executable.toLowerCase() === windowsPowerShellPath().toLowerCase() &&
		actual.arguments === taskArguments(desired) &&
		actual.workingDirectory === desired.home &&
		actual.userSid === desired.userSid &&
		actual.logonUserSid === desired.userSid &&
		actual.logonType === "InteractiveToken" &&
		actual.runLevel === "LeastPrivilege"
	);
}

export async function installScheduledTask(
	dataDirectory: string,
	source: CollectorSource,
): Promise<string> {
	const file = taskDefinitionPath(source);
	await ensurePrivateDirectory(servicesDirectory());
	await ensurePrivateDirectory(path.dirname(windowsLogPath(source)));
	await stopTask(source);
	const xml = scheduledTaskXml(await desiredTask(dataDirectory, source));
	await fs.writeFile(
		file,
		Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]),
	);
	await schtasks(source, "/Create", "/XML", file, "/F");
	await schtasks(source, "/Run");
	return file;
}

export async function uninstallScheduledTask(
	source: CollectorSource,
): Promise<void> {
	await stopTask(source);
	if ((await observedTask(source)) !== null)
		await schtasks(source, "/Delete", "/F");
	await fs.rm(taskDefinitionPath(source), { force: true });
}

export async function scheduledTaskStatus(
	source: CollectorSource,
): Promise<boolean> {
	return (await observedTask(source))?.state === 4;
}
