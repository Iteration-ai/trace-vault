import { collectorLogger } from "./logger.js";
import { ensurePrivateDirectory } from "./private-storage.js";
import { promises as fs } from "node:fs";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as z from "zod";
import {
	COLLECTOR_SOURCES,
	parseCollectorEnrollmentResponse,
	type CollectorSource,
} from "iteration-trace-contracts";
import { installBackgroundService } from "./background-service.js";
import { type CollectorFetcher, collectorFetch } from "./collector-fetch.js";
import { installTurnSummary } from "./turn-summary.js";
import { installCursorHooks } from "./cursor-hooks.js";
import {
	assertFreshCollectorDirectory,
	collectorPaths,
	defaultCollectorDirectory,
	loadConfig,
	prepareSourceInitialState,
	saveConfig,
	saveState,
	validateCollectorEndpoint,
	type CollectorConfig,
	type CollectorState,
} from "./storage.js";

export type MachineConsent = Readonly<{
	version: 1;
	endpoint: string;
	organizationId: string;
	anchorSource: CollectorSource;
	anchorDataDirectory: string;
	sourceHomes: Readonly<{ codex: string; claude: string; cursor: string }>;
}>;

const consentSchema: z.ZodType<MachineConsent> = z
	.object({
		version: z.literal(1),
		endpoint: z.url(),
		organizationId: z.uuid(),
		anchorSource: z.enum(COLLECTOR_SOURCES),
		anchorDataDirectory: z.string(),
		sourceHomes: z
			.object({
				codex: z.string(),
				claude: z.string(),
				cursor: z.string().default(path.join(os.homedir(), ".cursor")),
			})
			.strict(),
	})
	.strict();

function consentPath(): string {
	return path.join(os.homedir(), ".config", "iteration", "auto-connect.json");
}

export function sourceHome(source: CollectorSource): string {
	return path.resolve(
		source === "codex"
			? (process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"))
			: source === "claude"
				? (process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"))
				: path.join(os.homedir(), ".cursor"),
	);
}

export async function detectedSources(
	sourceHomes: MachineConsent["sourceHomes"],
): Promise<CollectorSource[]> {
	const detected: CollectorSource[] = [];
	for (const source of COLLECTOR_SOURCES) {
		const directory = path.join(
			sourceHomes[source],
			source === "codex" ? "sessions" : "projects",
		);
		let stats;
		try {
			stats = await fs.stat(directory);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				continue;
			throw new Error(`Could not inspect ${source} sessions at ${directory}.`, {
				cause: error,
			});
		}
		if (!stats.isDirectory()) {
			throw new Error(
				`${source} session path is not a directory: ${directory}.`,
			);
		}
		detected.push(source);
	}
	return detected;
}

export async function loadMachineConsent(): Promise<MachineConsent | null> {
	let text: string;
	try {
		text = await fs.readFile(consentPath(), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw new Error("Could not read automatic source connection settings.", {
			cause: error,
		});
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch (error) {
		throw new Error("Automatic source connection settings are invalid.", {
			cause: error,
		});
	}
	const parsed = consentSchema.safeParse(decoded);
	if (!parsed.success)
		throw new Error("Automatic source connection settings are invalid.");
	validateCollectorEndpoint(parsed.data.endpoint);
	return parsed.data;
}

export async function saveMachineConsent(
	consent: MachineConsent,
): Promise<void> {
	const parsed = consentSchema.parse(consent);
	validateCollectorEndpoint(parsed.endpoint);
	const filename = consentPath();
	await ensurePrivateDirectory(path.dirname(filename));
	const temporary = `${filename}.${process.pid}.tmp`;
	const handle = await fs.open(temporary, "w", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, filename);
}

export type SourceEnrollment = Readonly<{
	token: string;
	organizationId: string;
	organizationName: string;
}>;

export async function readCollectorScope(anchor: CollectorConfig): Promise<
	Readonly<{
		organizationId: string;
		organizationName: string;
	}>
> {
	const endpoint = validateCollectorEndpoint(anchor.endpoint);
	const response = await collectorFetch(
		new URL("./collector-auth/expand", endpoint),
		{
			headers: { Authorization: `Bearer ${anchor.token}` },
			signal: AbortSignal.timeout(10_000),
		},
	);
	const payload: unknown = await response.json();
	if (!response.ok) {
		const error = z.object({ error: z.string() }).safeParse(payload);
		throw new Error(
			`Could not identify the collector workspace: ${error.success ? error.data.error : `HTTP ${response.status}`}`,
		);
	}
	const parsed = z
		.object({ organizationId: z.uuid(), organizationName: z.string().min(1) })
		.strict()
		.safeParse(payload);
	if (!parsed.success)
		throw new Error("Iteration returned an invalid collector workspace.");
	return parsed.data;
}

export async function expandSource(
	anchor: CollectorConfig,
	source: CollectorSource,
	organizationId: string | null,
	request: CollectorFetcher = collectorFetch,
): Promise<SourceEnrollment> {
	const endpoint = validateCollectorEndpoint(anchor.endpoint);
	const token = createHmac("sha256", anchor.token)
		.update(`iteration-source:${source}`, "utf8")
		.digest("base64url");
	const response = await request(new URL("./collector-auth/expand", endpoint), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${anchor.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			source,
			token,
			...(organizationId === null ? {} : { organizationId }),
		}),
		signal: AbortSignal.timeout(15_000),
	});
	const payload: unknown = await response.json();
	if (!response.ok) {
		const error = z.object({ error: z.string() }).safeParse(payload);
		throw new Error(
			`Could not connect ${source}: ${error.success ? error.data.error : `HTTP ${response.status}`}`,
		);
	}
	const parsed = parseCollectorEnrollmentResponse(payload);
	if (!parsed.success || parsed.value.status !== "enrolled") {
		throw new Error(
			`Iteration returned an invalid ${source} connection response.`,
		);
	}
	if (
		organizationId !== null &&
		parsed.value.organizationId !== organizationId
	) {
		throw new Error(
			`Iteration connected ${source} to an unexpected workspace.`,
		);
	}
	return parsed.value;
}

export async function activateSource(
	source: CollectorSource,
	home: string,
	endpoint: string,
	enrollment: SourceEnrollment,
	state: CollectorState,
): Promise<CollectorConfig> {
	const directory = defaultCollectorDirectory(source);
	const paths = collectorPaths(directory);
	await assertFreshCollectorDirectory(paths, source);
	const common = {
		endpoint,
		token: enrollment.token,
		dataDirectory: directory,
		organizationId: enrollment.organizationId,
		organizationName: enrollment.organizationName,
	};
	const config: CollectorConfig =
		source === "codex"
			? { ...common, codexHome: home }
			: source === "claude"
				? { ...common, source: "claude", claudeHome: home }
				: { ...common, source: "cursor", cursorHome: home };
	await saveConfig(config, paths);
	try {
		await saveState(state, paths);
		if (source === "cursor") await installCursorHooks(home, directory);
		await installBackgroundService(directory, source);
	} catch (error) {
		throw new Error(
			`${source} was connected, but local startup failed. Run iteration start ${source} to repair it.`,
			{ cause: error },
		);
	}
	return config;
}

export async function connectNewDetectedSources(
	anchor: CollectorConfig,
	consent: MachineConsent,
): Promise<CollectorSource[]> {
	if (
		anchor.dataDirectory !== consent.anchorDataDirectory ||
		anchor.endpoint !== consent.endpoint
	) {
		throw new Error(
			"Automatic connection settings do not match the running collector.",
		);
	}
	const detected = await detectedSources(consent.sourceHomes);
	const connected: CollectorSource[] = [];
	for (const source of detected) {
		if (source === consent.anchorSource) continue;
		const paths = collectorPaths(defaultCollectorDirectory(source));
		try {
			await fs.access(paths.config);
			continue;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		await assertFreshCollectorDirectory(paths, source);
		const state = await prepareSourceInitialState(
			source,
			consent.sourceHomes[source],
			true,
		);
		const enrollment = await expandSource(
			anchor,
			source,
			consent.organizationId,
		);
		const config = await activateSource(
			source,
			consent.sourceHomes[source],
			consent.endpoint,
			enrollment,
			state,
		);
		connected.push(source);
		try {
			if (source !== "cursor") await installTurnSummary(config);
		} catch (error) {
			collectorLogger({
				level: "warning",
				source,
				operation: "install_turn_summary",
				message:
					error instanceof Error
						? error.message
						: "The turn summary could not be installed.",
			});
		}
	}
	return connected;
}

export async function connectedConfig(
	source: CollectorSource,
): Promise<CollectorConfig | null> {
	const paths = collectorPaths(defaultCollectorDirectory(source));
	try {
		await fs.access(paths.config);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
	return loadConfig(paths);
}
