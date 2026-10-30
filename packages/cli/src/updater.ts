import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import type { CollectorSource } from "iteration-trace-contracts";
import * as z from "zod";
import {
	compareVersions,
	deviceRolloutKey,
	ensureRuntimeDirectory,
	installVersionDirectory,
	isVersion,
	nodeRequirement,
	pruneVersions,
	readRuntimeSettings,
	readRuntimeState,
	rolloutDelayMs,
	type RuntimePaths,
	type RuntimeState,
	tryUpdateLock,
	withRuntimeLock,
	writeRuntimeState,
} from "./runtime.js";

const execFile = promisify(execFileCallback);
// GNU tar parses C:\... as host:file; Windows ships libarchive tar in
// System32, which accepts drive-letter paths.
const TAR =
	process.platform === "win32"
		? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
		: "tar";
const PACKAGE_NAME = "iteration-cli";
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
// Automatic checks run inside the collection loop, so a stalled registry must
// not hold collection for longer than this.
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const SELF_CHECK_TIMEOUT_MS = 60_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const versionManifestSchema = z
	.object({
		version: z.string(),
		deprecated: z.string().optional(),
		engines: z.object({ node: z.string().optional() }).loose().optional(),
		dist: z
			.object({ tarball: z.string().url(), integrity: z.string() })
			.loose(),
	})
	.loose();

const registryDocumentSchema = z
	.object({
		"dist-tags": z.object({ latest: z.string() }).loose(),
		versions: z.record(z.string(), versionManifestSchema),
		time: z.record(z.string(), z.string()).optional(),
	})
	.loose();

export type UpdateOutcome =
	| Readonly<{ kind: "up_to_date"; version: string }>
	| Readonly<{ kind: "waiting"; version: string; reason: string }>
	| Readonly<{ kind: "busy" }>
	| Readonly<{ kind: "updated"; from: string; to: string }>;

export function validateRegistryUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error("The update registry must be a valid URL.", {
			cause: error,
		});
	}
	const loopback =
		url.hostname === "127.0.0.1" ||
		url.hostname === "localhost" ||
		url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("The update registry must use HTTPS.");
	}
	if (url.username !== "" || url.password !== "" || url.search !== "")
		throw new Error(
			"The update registry URL cannot include credentials or a query.",
		);
	if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
	return url;
}

function request(
	url: URL,
	accept: string,
	signal: AbortSignal,
): Promise<http.IncomingMessage> {
	const transport = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const outgoing = transport.request(
			url,
			{ method: "GET", headers: { accept }, signal },
			(response) => {
				if (response.statusCode !== 200) {
					response.resume();
					reject(
						new Error(
							`${url.origin} answered ${response.statusCode ?? "without a status"} for ${url.pathname}.`,
						),
					);
					return;
				}
				resolve(response);
			},
		);
		outgoing.on("error", reject);
		outgoing.end();
	});
}

function limit(maxBytes: number, label: string): Transform {
	let size = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			size += chunk.byteLength;
			if (size > maxBytes) {
				callback(new Error(`The ${label} is larger than ${maxBytes} bytes.`));
				return;
			}
			callback(null, chunk);
		},
	});
}

async function fetchRegistryDocument(
	registry: URL,
	signal: AbortSignal,
): Promise<z.infer<typeof registryDocumentSchema>> {
	const response = await request(
		new URL(PACKAGE_NAME, registry),
		"application/json",
		signal,
	);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of response) {
		size += chunk.byteLength;
		if (size > MAX_METADATA_BYTES) {
			response.destroy();
			throw new Error(
				`The registry response is larger than ${MAX_METADATA_BYTES} bytes.`,
			);
		}
		chunks.push(chunk);
	}
	const parsed = registryDocumentSchema.safeParse(
		JSON.parse(Buffer.concat(chunks).toString("utf8")),
	);
	if (!parsed.success) {
		throw new Error("The update registry returned unexpected package data.", {
			cause: parsed.error,
		});
	}
	return parsed.data;
}

async function downloadVerified(
	url: URL,
	integrity: string,
	filename: string,
	signal: AbortSignal,
): Promise<void> {
	const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
	if (match === null)
		throw new Error("The release does not publish a sha512 integrity hash.");
	const hash = createHash("sha512");
	const response = await request(url, "application/octet-stream", signal);
	await pipeline(
		response,
		limit(MAX_TARBALL_BYTES, "release download"),
		new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				hash.update(chunk);
				callback(null, chunk);
			},
		}),
		createWriteStream(filename, { mode: 0o600 }),
	);
	if (hash.digest("base64") !== match[1])
		throw new Error(
			"The downloaded release does not match its published hash.",
		);
}

type Candidate = Readonly<{
	version: string;
	tarball: URL;
	integrity: string;
}>;

// The release that `latest` names, if this computer should install it now.
export function selectCandidate(
	document: z.infer<typeof registryDocumentSchema>,
	registry: URL,
	state: RuntimeState,
	options: Readonly<{
		nowMs: number;
		manual: boolean;
		nodeVersion: string;
		deviceKey: string;
	}>,
): Readonly<{ kind: "install"; candidate: Candidate }> | UpdateOutcome {
	const version = document["dist-tags"].latest;
	if (!isVersion(version))
		throw new Error(`The registry names an invalid latest version ${version}.`);
	if (compareVersions(version, state.current) <= 0)
		return { kind: "up_to_date", version: state.current };
	const manifest = document.versions[version];
	if (manifest === undefined || manifest.version !== version)
		throw new Error(`The registry does not describe version ${version}.`);
	if (manifest.deprecated !== undefined)
		return {
			kind: "waiting",
			version,
			reason: `${version} was withdrawn: ${manifest.deprecated}`,
		};
	const rejected = state.rejected.find((item) => item.version === version);
	if (rejected !== undefined)
		return {
			kind: "waiting",
			version,
			reason: `${version} was rolled back on this computer: ${rejected.reason}`,
		};
	const node = nodeRequirement(manifest.engines?.node, options.nodeVersion);
	if (!node.ok)
		return {
			kind: "waiting",
			version,
			reason: `${version} cannot run here because ${node.reason}`,
		};
	if (!options.manual) {
		const publishedAtMs = Date.parse(document.time?.[version] ?? "");
		if (Number.isNaN(publishedAtMs))
			throw new Error(
				`The registry does not say when ${version} was published.`,
			);
		if (options.nowMs < publishedAtMs + rolloutDelayMs(options.deviceKey))
			return {
				kind: "waiting",
				version,
				reason: `${version} reaches this computer later in its rollout`,
			};
	}
	const tarball = new URL(manifest.dist.tarball);
	if (tarball.origin !== registry.origin)
		throw new Error(
			`The release download is not served by the update registry (${tarball.origin}).`,
		);
	return {
		kind: "install",
		candidate: { version, tarball, integrity: manifest.dist.integrity },
	};
}

// Runs the candidate against this computer's collector state without
// collecting, so a release that cannot read existing data never starts.
async function selfCheck(
	paths: RuntimePaths,
	cliPath: string,
	version: string,
): Promise<void> {
	let stdout: string;
	try {
		({ stdout } = await execFile(process.execPath, [cliPath, "self-check"], {
			timeout: SELF_CHECK_TIMEOUT_MS,
			windowsHide: true,
			env: {
				...process.env,
				HOME: paths.home,
				USERPROFILE: paths.home,
				ITERATION_RUNTIME_VERSION: version,
			},
		}));
	} catch (error) {
		const stderr =
			error instanceof Error && "stderr" in error ? String(error.stderr) : "";
		throw new Error(
			`Version ${version} failed its self-check${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : "."}`,
			{ cause: error },
		);
	}
	if (stdout.trim() !== version)
		throw new Error(
			`Version ${version} reported ${stdout.trim().slice(0, 40)}.`,
		);
}

async function installCandidate(
	paths: RuntimePaths,
	candidate: Candidate,
	signal: AbortSignal,
): Promise<void> {
	await ensureRuntimeDirectory(paths);
	const staged = await fs.mkdtemp(
		path.join(paths.staging, `download-${candidate.version}-`),
	);
	try {
		const archive = path.join(staged, "package.tgz");
		await downloadVerified(
			candidate.tarball,
			candidate.integrity,
			archive,
			signal,
		);
		const extracted = path.join(staged, "extracted");
		await fs.mkdir(extracted, { mode: 0o700 });
		await execFile(TAR, ["-xzf", archive, "-C", extracted], {
			timeout: REQUEST_TIMEOUT_MS,
			windowsHide: true,
		});
		const packageRoot = path.join(extracted, "package");
		await selfCheck(
			paths,
			path.join(packageRoot, "dist", "cli.js"),
			candidate.version,
		);
		await installVersionDirectory(paths, packageRoot, candidate.version);
	} finally {
		await fs.rm(staged, { recursive: true, force: true });
	}
}

// Makes `version` current on trial. Collectors pick it up when they restart,
// and each must confirm a healthy pass before the trial ends.
export async function switchVersion(
	paths: RuntimePaths,
	from: string,
	version: string,
	previous: string,
	expected: readonly CollectorSource[],
	nowMs: number,
): Promise<void> {
	await withRuntimeLock(paths, async () => {
		const state = await readRuntimeState(paths);
		if (state === null || state.current !== from) {
			throw new Error(
				"Another Iteration process changed the installed version; the update was not applied.",
			);
		}
		await writeRuntimeState(paths, {
			...state,
			current: version,
			previous,
			trial: {
				version,
				previous,
				startedAtMs: nowMs,
				expected: [...expected],
				starts: {},
				confirmed: [],
			},
		});
	});
	await pruneVersions(paths, [version, previous]);
}

async function recordCheck(
	paths: RuntimePaths,
	atMs: number,
	error: string | null,
): Promise<void> {
	await withRuntimeLock(paths, async () => {
		const state = await readRuntimeState(paths);
		if (state === null) return;
		await writeRuntimeState(paths, {
			...state,
			lastCheck: { atMs, error: error?.slice(0, 500) ?? null },
		});
	});
}

export async function updateRuntime(
	paths: RuntimePaths,
	options: Readonly<{
		manual: boolean;
		expected: readonly CollectorSource[];
		nowMs: number;
		signal: AbortSignal;
	}>,
): Promise<UpdateOutcome> {
	const release = await tryUpdateLock(paths);
	if (release === null) return { kind: "busy" };
	const signal = AbortSignal.any([
		options.signal,
		AbortSignal.timeout(UPDATE_TIMEOUT_MS),
	]);
	try {
		const state = await readRuntimeState(paths);
		if (state === null)
			throw new Error("Iteration is not installed on this computer.");
		if (state.trial !== null)
			return {
				kind: "waiting",
				version: state.trial.version,
				reason: `${state.trial.version} is still being confirmed on this computer`,
			};
		const settings = await readRuntimeSettings(paths);
		const registry = validateRegistryUrl(settings.registry);
		try {
			const selection = selectCandidate(
				await fetchRegistryDocument(registry, signal),
				registry,
				state,
				{
					nowMs: options.nowMs,
					manual: options.manual,
					nodeVersion: process.versions.node,
					deviceKey: deviceRolloutKey(),
				},
			);
			if (selection.kind !== "install") {
				await recordCheck(paths, options.nowMs, null);
				return selection;
			}
			await installCandidate(paths, selection.candidate, signal);
			await switchVersion(
				paths,
				state.current,
				selection.candidate.version,
				state.current,
				options.expected,
				options.nowMs,
			);
			await recordCheck(paths, options.nowMs, null);
			return {
				kind: "updated",
				from: state.current,
				to: selection.candidate.version,
			};
		} catch (error) {
			await recordCheck(
				paths,
				options.nowMs,
				error instanceof Error ? error.message : "The update check failed.",
			);
			throw error;
		}
	} finally {
		await release();
	}
}
