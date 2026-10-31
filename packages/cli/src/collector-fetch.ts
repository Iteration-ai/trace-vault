import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { collectorLogger } from "./logger.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// Reused connections failed uploads in production: Node's HTTP/2 fetch kept a
// destroyed session, and kept-alive sockets timed out on ~40 s server waits.
// See docs/architecture/trace-ingestion.md.
const agents = {
	"http:": new http.Agent({ keepAlive: false }),
	"https:": new https.Agent({ keepAlive: false }),
};

type CollectorRequest = Readonly<{
	method?: "GET" | "POST" | "PUT";
	headers?: Readonly<Record<string, string>>;
	body?: string;
	signal?: AbortSignal;
}>;

export type CollectorFetcher = (
	url: string | URL,
	init?: CollectorRequest,
) => Promise<Response>;

const sendCollectorRequest: CollectorFetcher = (input, init = {}) => {
	const url = new URL(input);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new TypeError(
			`Unsupported collector request protocol ${url.protocol}`,
		);
	}
	const body = init.body ?? null;
	const headers: Record<string, string> = { ...init.headers };
	if (body !== null) {
		headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
	}
	const transport = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const request = transport.request(
			url,
			{
				method: init.method ?? "GET",
				headers,
				agent: agents[url.protocol as "http:" | "https:"],
				signal: init.signal,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.byteLength;
					if (size > MAX_RESPONSE_BYTES) {
						response.destroy(
							new Error("Collector endpoint returned an oversized response."),
						);
						return;
					}
					chunks.push(chunk);
				});
				response.on("error", reject);
				response.on("end", () => {
					const status = response.statusCode ?? 0;
					const responseHeaders = new Headers();
					for (const [name, value] of Object.entries(response.headers)) {
						if (value === undefined) continue;
						for (const item of Array.isArray(value) ? value : [value]) {
							responseHeaders.append(name, item);
						}
					}
					resolve(
						new Response(
							NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks),
							{ status, headers: responseHeaders },
						),
					);
				});
			},
		);
		request.on("error", reject);
		request.end(body ?? undefined);
	});
};

export const collectorFetch: CollectorFetcher = async (input, init = {}) => {
	const requestId = randomUUID();
	const started = performance.now();
	const headers = new Headers(init.headers);
	headers.set("X-Request-ID", requestId);
	try {
		const response = await sendCollectorRequest(input, {
			...init,
			headers: Object.fromEntries(headers),
		});
		collectorLogger({
			level: response.ok ? "info" : "warning",
			operation: "http_request",
			requestId,
			method: init.method ?? "GET",
			status: response.status,
			durationMs: Math.round(performance.now() - started),
		});
		return response;
	} catch (error) {
		collectorLogger({
			level: "error",
			operation: "http_request",
			requestId,
			method: init.method ?? "GET",
			errorName: error instanceof Error ? error.name : "UnknownError",
			durationMs: Math.round(performance.now() - started),
		});
		throw error;
	}
};
