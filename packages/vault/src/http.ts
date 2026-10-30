import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import * as z from "zod";
import { parseTraceEventBatch } from "iteration-trace-contracts";
import { VaultStore } from "./store.js";
import {
	VaultStoreError,
	type VaultCaller,
	type VaultPageRequest,
	type VaultSessionIdentity,
} from "./store-contracts.js";
import {
	hashPassword,
	newSecret,
	secretHash,
	verifyPassword,
} from "./password.js";
import {
	enrollmentSchema,
	invitationSchema,
	joinSchema,
	loginSchema,
	memberChangeSchema,
	ownPolicySchema,
	pageSchema,
	repositoriesSchema,
	setupSchema,
} from "./http-contracts.js";

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const secretSchema = z.string().regex(/^(vs|vd)_[A-Za-z0-9_-]{43}$/);

export type VaultHttpOptions = Readonly<{
	publicUrl: string;
	bootstrapToken: string;
	publicDirectory: string;
}>;

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function json(response: ServerResponse, status: number, body?: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(body === undefined ? undefined : JSON.stringify(body));
}

function caller(
	request: IncomingMessage,
	kind: "session" | "device" = "session",
): VaultCaller {
	const bearer = /^Bearer (\S+)$/.exec(
		request.headers.authorization ?? "",
	)?.[1];
	const cookie = /(?:^|;\s*)vault_session=([^;]+)/.exec(
		request.headers.cookie ?? "",
	)?.[1];
	const secret = secretSchema.safeParse(bearer ?? cookie);
	if (!secret.success) throw new HttpError(401, "Sign in to this vault.");
	const actualKind = secret.data.startsWith("vd_") ? "device" : "session";
	if (actualKind !== kind)
		throw new HttpError(403, "This credential cannot perform this operation.");
	return { kind, tokenHash: secretHash(secret.data) };
}

function cookie(
	response: ServerResponse,
	token: string,
	secure: boolean,
	maxAge = SESSION_SECONDS,
): void {
	response.setHeader(
		"Set-Cookie",
		`vault_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
	);
}

async function body<T>(
	request: IncomingMessage,
	schema: z.ZodType<T>,
): Promise<T> {
	if (
		request.headers["content-type"]?.split(";")[0]?.trim() !==
		"application/json"
	)
		throw new HttpError(415, "Send application/json.");
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += data.length;
		if (bytes > MAX_BODY_BYTES)
			throw new HttpError(413, "Request exceeds 4 MiB.");
		chunks.push(data);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Request must contain valid JSON.");
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		throw new HttpError(
			400,
			parsed.error.issues[0]?.message ?? "Invalid request.",
		);
	return parsed.data;
}

function page(url: URL): VaultPageRequest {
	const parsed = pageSchema.safeParse(Object.fromEntries(url.searchParams));
	if (!parsed.success) throw new HttpError(400, "Invalid pagination.");
	return { after: parsed.data.cursor, limit: parsed.data.limit };
}

function sessionToken() {
	const token = newSecret("session");
	return {
		token,
		stored: {
			tokenHash: secretHash(token),
			expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
		},
	};
}

function identity(session: {
	memberId: string;
	source: VaultSessionIdentity["source"];
	sourceSessionId: string;
}): VaultSessionIdentity {
	return {
		memberId: session.memberId,
		source: session.source,
		sourceSessionId: session.sourceSessionId,
	};
}

async function authenticate(
	request: IncomingMessage,
	response: ServerResponse,
	route: string,
	store: VaultStore,
	options: VaultHttpOptions,
): Promise<boolean> {
	if (request.method !== "POST") return false;
	const secure = new URL(options.publicUrl).protocol === "https:";
	if (route === "/api/auth/logout") {
		await store.logout(caller(request));
		cookie(response, "", secure, 0);
		json(response, 204);
		return true;
	}
	if (!["/api/setup", "/api/auth/login", "/api/auth/join"].includes(route))
		return false;
	const session = sessionToken();
	let member;
	if (route === "/api/setup") {
		const input = await body(request, setupSchema);
		if (
			!timingSafeEqual(
				Buffer.from(secretHash(input.bootstrapToken)),
				Buffer.from(secretHash(options.bootstrapToken)),
			)
		)
			throw new HttpError(403, "Invalid bootstrap token.");
		await store.initialize(input.name, {
			email: input.email,
			name: input.displayName,
			passwordHash: await hashPassword(input.password),
		});
		member = await store.login(
			input.email,
			(hash) => verifyPassword(input.password, hash),
			session.stored,
		);
	} else if (route === "/api/auth/join") {
		const input = await body(request, joinSchema);
		member = await store.redeemInvitation(
			secretHash(input.token),
			await hashPassword(input.password),
			session.stored,
		);
	} else {
		const input = await body(request, loginSchema);
		member = await store.login(
			input.email,
			(hash) => verifyPassword(input.password, hash),
			session.stored,
		);
	}
	cookie(response, session.token, secure);
	json(response, 200, { token: session.token, member });
	return true;
}

async function manage(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	store: VaultStore,
): Promise<boolean> {
	const route = url.pathname;
	const operation = `${request.method} ${route}`;
	if (operation === "GET /api/me") {
		const member = await store.me(caller(request));
		json(response, 200, { member, vaultName: (await store.status()).name });
	} else if (operation === "GET /api/me/capture-rules") {
		json(response, 200, await store.getPolicy(caller(request)));
	} else if (operation === "PUT /api/me/capture-rules") {
		json(
			response,
			200,
			await store.updateOwnPolicy(
				caller(request),
				await body(request, ownPolicySchema),
			),
		);
	} else if (operation === "PUT /api/settings/policy") {
		json(
			response,
			200,
			await store.updateRepositories(
				caller(request),
				(await body(request, repositoriesSchema)).repositories,
			),
		);
	} else if (operation === "POST /api/invitations") {
		const token = newSecret("invitation");
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await store.createInvitation(
			caller(request),
			await body(request, invitationSchema),
			{ tokenHash: secretHash(token), expiresAt },
		);
		json(response, 201, { invitationToken: token, expiresAt });
	} else if (operation === "GET /api/members") {
		json(response, 200, await store.listMembers(caller(request), page(url)));
	} else if (
		/^\/api\/members\/[^/]+$/.test(route) &&
		request.method === "PATCH"
	) {
		const id = z.uuid().parse(route.split("/").at(-1));
		await store.updateMember(
			caller(request),
			id,
			await body(request, memberChangeSchema),
		);
		json(response, 204);
	} else if (operation === "GET /api/devices") {
		json(response, 200, await store.listDevices(caller(request), page(url)));
	} else if (
		/^\/api\/devices\/[^/]+$/.test(route) &&
		request.method === "DELETE"
	) {
		await store.revokeDevice(
			caller(request),
			z.uuid().parse(route.split("/").at(-1)),
		);
		json(response, 204);
	} else if (operation === "GET /api/audit") {
		json(response, 200, await store.listAudit(caller(request), page(url)));
	} else return false;
	return true;
}

async function collect(
	request: IncomingMessage,
	response: ServerResponse,
	route: string,
	store: VaultStore,
): Promise<boolean> {
	if (route === "/api/collector/enroll" && request.method === "POST") {
		const input = await body(request, enrollmentSchema);
		const token = newSecret("device");
		const device = await store.enrollDevice(caller(request), {
			source: input.source,
			name: input.deviceName,
			tokenHash: secretHash(token),
		});
		const status = await store.status();
		json(response, 200, {
			status: "enrolled",
			token,
			deviceId: device.id,
			organizationId: status.id,
			organizationName: status.name,
		});
	} else if (route === "/api/collector/policy" && request.method === "GET") {
		json(response, 200, await store.getPolicy(caller(request, "device")));
	} else if (route === "/api/traces/ingest" && request.method === "POST") {
		const raw = await body(request, z.unknown());
		const parsed = parseTraceEventBatch(raw);
		if (!parsed.success) throw new HttpError(400, parsed.error);
		const revision = parsed.value.events[0]?.capture?.revision;
		if (revision === undefined)
			throw new HttpError(403, "Capture authorization is required.");
		const deviceCaller = caller(request, "device");
		const result = await store.ingest(
			deviceCaller,
			revision,
			parsed.value.events,
		);
		const device = await store.deviceIdentity(deviceCaller);
		json(response, 202, {
			deviceId: device.id,
			acceptedEventIds: result.acceptedEventIds,
		});
	} else return false;
	return true;
}

async function exportSession(
	request: IncomingMessage,
	response: ServerResponse,
	store: VaultStore,
	actor: VaultCaller,
	scope: VaultSessionIdentity,
): Promise<void> {
	response.writeHead(200, {
		"Content-Type": "application/x-ndjson",
		"Content-Disposition": 'attachment; filename="trace-vault-session.ndjson"',
	});
	const deadline = Date.now() + 300_000;
	let after: string | undefined;
	let count = 0;
	do {
		if (response.destroyed || (request.destroyed && !request.complete)) return;
		if (Date.now() >= deadline || count >= 1_000_000)
			throw new HttpError(503, "Export capacity exceeded.");
		const result = await store.readEvents(actor, scope, { after, limit: 100 });
		for (const event of result.items) {
			if (!response.write(`${JSON.stringify(event.payload)}\n`))
				await once(response, "drain", { signal: AbortSignal.timeout(30_000) });
			count += 1;
		}
		after = result.nextCursor ?? undefined;
	} while (after);
	response.end();
}

async function traces(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	store: VaultStore,
): Promise<boolean> {
	if (url.pathname === "/api/sessions" && request.method === "GET") {
		json(response, 200, await store.listSessions(caller(request), page(url)));
		return true;
	}
	const match = /^\/api\/sessions\/([^/]+)(?:\/(events|export))?$/.exec(
		url.pathname,
	);
	if (!match) return false;
	const actor = caller(request);
	const session = await store.getSessionById(actor, z.uuid().parse(match[1]));
	if (request.method === "DELETE" && !match[2]) {
		await store.deleteSession(actor, identity(session));
		json(response, 204);
	} else if (request.method === "GET" && match[2] === "events") {
		const result = await store.readEvents(actor, identity(session), page(url));
		json(response, 200, {
			...result,
			items: result.items.map((event) => event.payload),
		});
	} else if (request.method === "GET" && match[2] === "export") {
		await exportSession(request, response, store, actor, identity(session));
	} else return false;
	return true;
}

const document =
	'<!doctype html><html lang="en" data-theme="light" data-theme-scope="document"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trace vault</title><link rel="stylesheet" href="/vault.css"></head><body class="bg-canvas text-fg"><div id="root"></div><script type="module" src="/vault.js"></script></body></html>';

export function createVaultServer(
	store: VaultStore,
	options: VaultHttpOptions,
) {
	const publicOrigin = new URL(options.publicUrl).origin;
	let activeRequests = 0;
	let activeLogins = 0;
	const attempts = new Map<string, { count: number; expiresAt: number }>();
	const assets = new Map<string, Buffer>();
	async function servePage(
		request: IncomingMessage,
		response: ServerResponse,
		route: string,
	): Promise<boolean> {
		if (request.method !== "GET") return false;
		if (["/", "/join"].includes(route)) {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(document);
			return true;
		}
		if (!["/vault.js", "/vault.css"].includes(route)) return false;
		let asset = assets.get(route);
		if (!asset) {
			asset = await readFile(
				path.join(options.publicDirectory, route.slice(1)),
			);
			assets.set(route, asset);
		}
		response.writeHead(200, {
			"Content-Type": route.endsWith(".css") ? "text/css" : "text/javascript",
		});
		response.end(asset);
		return true;
	}
	async function signIn(
		request: IncomingMessage,
		response: ServerResponse,
		route: string,
	): Promise<boolean> {
		const isLogin =
			request.method === "POST" &&
			["/api/setup", "/api/auth/login", "/api/auth/join"].includes(route);
		if (!isLogin) return authenticate(request, response, route, store, options);
		const now = Date.now();
		for (const [key, value] of attempts)
			if (value.expiresAt <= now) attempts.delete(key);
		const key = request.socket.remoteAddress ?? "unknown";
		const attempt = attempts.get(key) ?? { count: 0, expiresAt: now + 60_000 };
		if (attempt.count >= 20 || attempts.size >= 10_000 || activeLogins >= 4)
			throw new HttpError(429, "Sign-in capacity reached; try again shortly.");
		attempt.count += 1;
		attempts.set(key, attempt);
		activeLogins += 1;
		try {
			return await authenticate(request, response, route, store, options);
		} finally {
			activeLogins -= 1;
		}
	}
	async function dispatch(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const url = new URL(request.url ?? "/", publicOrigin);
		const route = url.pathname;
		if (request.headers.origin && request.headers.origin !== publicOrigin)
			throw new HttpError(403, "Cross-origin access is not allowed.");
		if (request.method === "GET" && route === "/health")
			return json(response, 200, { status: "ok" });
		if (request.method === "GET" && route === "/ready") {
			await store.status();
			return json(response, 200, { status: "ready" });
		}
		if (request.method === "GET" && route === "/api/status")
			return json(response, 200, await store.status());
		if (await signIn(request, response, route)) return;
		if (await manage(request, response, url, store)) return;
		if (await collect(request, response, route, store)) return;
		if (await traces(request, response, url, store)) return;
		if (await servePage(request, response, route)) return;
		throw new HttpError(404, "Not found.");
	}
	const server = createServer((request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		);
		response.setHeader("X-Request-ID", randomUUID());
		response.setHeader("Vary", "Cookie, Authorization");
		if (activeRequests >= 32)
			return json(response, 503, { error: "Vault is busy; retry shortly." });
		activeRequests += 1;
		dispatch(request, response)
			.catch((error: unknown) => {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				const statuses = {
					unauthorized: 401,
					forbidden: 403,
					not_found: 404,
					conflict: 409,
					policy_changed: 409,
					invalid_input: 400,
					already_initialized: 409,
				};
				const status =
					error instanceof HttpError
						? error.status
						: error instanceof VaultStoreError
							? statuses[error.code]
							: error instanceof z.ZodError
								? 400
								: 503;
				if (status === 429 || status === 503)
					response.setHeader("Retry-After", "5");
				response.setHeader("Connection", "close");
				const message =
					error instanceof HttpError || error instanceof VaultStoreError
						? error.message
						: status === 400
							? "Invalid request."
							: "Vault operation failed; retry or contact your administrator.";
				json(response, status, {
					error: message,
					...(error instanceof VaultStoreError ? { code: error.code } : {}),
				});
			})
			.finally(() => {
				activeRequests -= 1;
			});
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	return server;
}
