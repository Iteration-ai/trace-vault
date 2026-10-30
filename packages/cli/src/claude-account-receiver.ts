import http, { type IncomingMessage, type ServerResponse } from "node:http";
import * as z from "zod";
import {
	CLAUDE_ACCOUNT_VERSION,
	saveClaudeAccountEvidence,
	type ClaudeAccountEvidence,
} from "./claude-account.js";

const attributeSchema = z.object({
	key: z.string().max(255),
	value: z.object({
		stringValue: z
			.string()
			.max(64 * 1024)
			.optional(),
	}),
});
const attributesSchema = z.array(attributeSchema).max(256);
const exportSchema = z.object({
	resourceLogs: z
		.array(
			z.object({
				resource: z.object({ attributes: attributesSchema }),
				scopeLogs: z
					.array(
						z.object({
							logRecords: z
								.array(z.object({ attributes: attributesSchema }))
								.max(1000),
						}),
					)
					.max(16),
			}),
		)
		.max(16),
});
const uuid = z.uuid();
const identifier = z.string().regex(/^[A-Za-z0-9_:./-]{1,255}$/);

function attributes(
	values: z.infer<typeof attributesSchema>,
): Map<string, string> {
	const result = new Map<string, string>();
	for (const entry of values) {
		if (result.has(entry.key))
			throw new Error("Duplicate telemetry attribute.");
		if (entry.value.stringValue !== undefined)
			result.set(entry.key, entry.value.stringValue);
	}
	return result;
}

function validId(
	schema: z.ZodType<string>,
	value: string | undefined,
): string | null {
	const parsed = schema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function claudeMetadataFromOtlp(
	value: unknown,
	receivedAt = Date.now(),
): ClaudeAccountEvidence[] {
	const parsed = exportSchema.safeParse(value);
	if (!parsed.success)
		throw new Error("Expected a bounded OTLP HTTP/JSON logs export.");
	const evidence: ClaudeAccountEvidence[] = [];
	for (const resource of parsed.data.resourceLogs) {
		const metadata = attributes(resource.resource.attributes);
		if (
			metadata.get("service.name") !== "claude-code" ||
			metadata.get("service.version") !== CLAUDE_ACCOUNT_VERSION
		)
			throw new Error(
				`Account evidence supports terminal Claude Code ${CLAUDE_ACCOUNT_VERSION} only; this runtime is unsupported.`,
			);
		for (const scope of resource.scopeLogs)
			for (const log of scope.logRecords) {
				const fields = attributes(log.attributes);
				const record = metadataRecord(fields, receivedAt);
				if (record !== null) evidence.push(record);
				if (evidence.length > 1000)
					throw new Error("Metadata export exceeds 1,000 events.");
			}
	}
	return evidence;
}

function metadataRecord(
	fields: ReadonlyMap<string, string>,
	receivedAt: number,
): ClaudeAccountEvidence | null {
	const event = z
		.enum(["user_prompt", "api_request", "assistant_response", "tool_result"])
		.safeParse(fields.get("event.name"));
	const sessionId = validId(uuid, fields.get("session.id"));
	if (!event.success || sessionId === null) return null;
	const requestLevel =
		event.data === "api_request" || event.data === "assistant_response";
	const accountId = requestLevel
		? validId(identifier, fields.get("user.account_uuid"))
		: null;
	const organizationId = requestLevel
		? validId(identifier, fields.get("organization.id"))
		: null;
	if (requestLevel && accountId === null) return null;
	if (requestLevel && fields.has("organization.id") && organizationId === null)
		return null;
	return {
		event: event.data,
		sessionId,
		promptId: validId(uuid, fields.get("prompt.id")),
		messageId: validId(uuid, fields.get("message.uuid")),
		requestId: validId(identifier, fields.get("request_id")),
		toolId: validId(identifier, fields.get("tool_use_id")),
		accountId,
		organizationId,
		receivedAt,
	};
}

function respond(
	response: ServerResponse,
	status: number,
	body: unknown,
): void {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		connection: "close",
	});
	response.end(JSON.stringify(body));
}

async function readExport(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		const buffer: Buffer = chunk;
		bytes += buffer.length;
		if (bytes > 512 * 1024) throw new Error("Metadata export exceeds 512 KiB.");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("Metadata export must contain valid JSON.");
	}
}

export async function startClaudeAccountReceiver(
	directory: string,
	port: number,
	secret: string,
): Promise<Readonly<{ port: number; close: () => Promise<void> }>> {
	let busy = false;
	let active: Promise<void> | null = null;
	const server = http.createServer((request, response) => {
		if (
			request.method !== "POST" ||
			request.url !== `/v1/logs/${secret}` ||
			request.headers.origin
		) {
			respond(response, 403, {
				error: "Not an authorized local telemetry export.",
			});
			return;
		}
		if (
			request.headers["content-type"]?.split(";")[0] !== "application/json" ||
			request.headers["content-encoding"]
		) {
			respond(response, 415, { error: "Use uncompressed OTLP HTTP/JSON." });
			return;
		}
		if (busy) {
			respond(response, 429, {
				error: "Metadata receiver is busy; retry export.",
			});
			return;
		}
		busy = true;
		active = (async () => {
			try {
				const records = claudeMetadataFromOtlp(await readExport(request));
				if (records.length > 0)
					await saveClaudeAccountEvidence(directory, records);
				respond(response, 200, {});
			} catch (error) {
				// Errors are fixed parser/storage diagnostics, never telemetry values.
				respond(response, 422, {
					error:
						error instanceof Error ? error.message : "Metadata export failed.",
				});
			} finally {
				busy = false;
				active = null;
			}
		})();
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 5000;
	server.maxConnections = 4;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address() as import("node:net").AddressInfo;
	return {
		port: address.port,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
			await active;
		},
	};
}
