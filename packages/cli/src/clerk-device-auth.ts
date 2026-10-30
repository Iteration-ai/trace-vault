import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import {
	parseCollectorEnrollmentResponse,
	type CollectorSource,
	type CollectorEnrollmentResponse,
} from "iteration-trace-contracts";
import * as z from "zod";
import { collectorFetch } from "./collector-fetch.js";
import {
	powershellLiteral,
	runWindowsPowerShell,
} from "./windows-powershell.js";

const execFileAsync = promisify(execFile);

const serverAuthConfigSchema = z
	.object({
		issuerUrl: z.url(),
		clientId: z.string().min(1),
	})
	.strict();

const oauthMetadataSchema = z.object({
	device_authorization_endpoint: z.url(),
	token_endpoint: z.url(),
	issuer: z.url().optional(),
});

const deviceCodeSchema = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.url(),
	verification_uri_complete: z.url().optional(),
	expires_in: z.number().int().min(1).max(86_400),
	interval: z.number().int().min(1).max(3_600),
});

const oauthTokenSchema = z.object({
	access_token: z.string().min(1),
});

const oauthErrorSchema = z.object({
	error: z.string().min(1),
	error_description: z.string().optional(),
});

type EnrollmentResult = CollectorEnrollmentResponse;

function apiRoute(endpoint: URL, relativePath: string): URL {
	return new URL(relativePath, endpoint);
}

async function responseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw new Error("The authentication server returned invalid JSON.", {
			cause: error,
		});
	}
}

async function loadOAuthConfiguration(endpoint: URL) {
	const response = await collectorFetch(
		apiRoute(endpoint, "./collector-auth/config"),
		{
			signal: AbortSignal.timeout(10_000),
		},
	);
	const body = await responseJson(response);
	if (!response.ok) {
		throw new Error(
			response.status === 503
				? "Collector sign-in is not configured on the Iteration server."
				: "Could not load collector sign-in configuration.",
		);
	}
	const parsed = serverAuthConfigSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error("Collector sign-in configuration has an invalid shape.");
	}
	const issuer = new URL(parsed.data.issuerUrl);
	if (
		issuer.protocol !== "https:" ||
		issuer.username !== "" ||
		issuer.password !== "" ||
		issuer.pathname !== "/" ||
		issuer.search !== "" ||
		issuer.hash !== ""
	) {
		throw new Error("The configured Clerk issuer URL is invalid.");
	}
	return { issuerUrl: issuer.origin, clientId: parsed.data.clientId };
}

async function discoverDeviceEndpoints(issuerUrl: string) {
	const issuer = new URL(issuerUrl);
	const response = await fetch(
		new URL(".well-known/oauth-authorization-server", issuer),
		{ signal: AbortSignal.timeout(10_000) },
	);
	if (!response.ok) {
		throw new Error("Clerk OAuth device authorization is unavailable.");
	}
	const parsed = oauthMetadataSchema.safeParse(await responseJson(response));
	if (!parsed.success) {
		throw new Error(
			"Clerk OAuth metadata does not advertise device authorization.",
		);
	}
	const deviceAuthorizationUrl = new URL(
		parsed.data.device_authorization_endpoint,
	);
	const tokenUrl = new URL(parsed.data.token_endpoint);
	if (
		deviceAuthorizationUrl.protocol !== "https:" ||
		tokenUrl.protocol !== "https:" ||
		deviceAuthorizationUrl.origin !== issuer.origin ||
		tokenUrl.origin !== issuer.origin
	) {
		throw new Error("Clerk OAuth metadata contains an unexpected endpoint.");
	}
	return {
		deviceAuthorizationUrl,
		tokenUrl,
	};
}

async function openBrowser(url: string): Promise<void> {
	try {
		if (process.platform === "win32")
			await runWindowsPowerShell(
				"open the verification page",
				`
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = ${powershellLiteral(url)}
$start.UseShellExecute = $true
[System.Diagnostics.Process]::Start($start) | Out-Null
`,
			);
		else if (process.platform === "linux")
			await execFileAsync("xdg-open", [url], { timeout: 5000 });
		else await execFileAsync("open", [url], { timeout: 5000 });
	} catch {
		process.stdout.write("Open the verification link in your browser.\n");
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestDeviceCode(url: URL, clientId: string) {
	const body = new URLSearchParams({
		client_id: clientId,
		scope: "openid profile email",
	});
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal: AbortSignal.timeout(10_000),
	});
	const payload = await responseJson(response);
	const parsed = deviceCodeSchema.safeParse(payload);
	if (!response.ok || !parsed.success) {
		const providerError = oauthErrorSchema.safeParse(payload);
		throw new Error(
			providerError.success
				? "Clerk device sign-in could not start: " +
						(providerError.data.error_description ?? providerError.data.error)
				: "Clerk returned an invalid device authorization response.",
		);
	}
	return parsed.data;
}

async function pollForAccessToken(
	tokenUrl: URL,
	clientId: string,
	deviceCode: string,
	expiresIn: number,
	initialInterval: number,
): Promise<string> {
	const expiresAt = Date.now() + expiresIn * 1000;
	let interval = initialInterval;
	while (Date.now() < expiresAt) {
		await delay(interval * 1000);
		if (Date.now() >= expiresAt) break;
		let response: Response;
		try {
			response = await fetch(tokenUrl, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: clientId,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: deviceCode,
				}),
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			continue;
		}

		const payload = await responseJson(response);
		const token = oauthTokenSchema.safeParse(payload);
		if (response.ok && token.success) return token.data.access_token;

		const providerError = oauthErrorSchema.safeParse(payload);
		if (!providerError.success) {
			throw new Error("Clerk returned an invalid device token response.");
		}
		switch (providerError.data.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				interval += 5;
				continue;
			case "access_denied":
				throw new Error("You denied Iteration collector access.");
			case "expired_token":
				throw new Error("The sign-in code expired. Run iteration again.");
			default:
				throw new Error(
					"Clerk device sign-in failed: " +
						(providerError.data.error_description ?? providerError.data.error),
				);
		}
	}
	throw new Error("The sign-in code expired. Run iteration again.");
}

async function clerkDeviceSignIn(
	configuration: Awaited<ReturnType<typeof loadOAuthConfiguration>>,
): Promise<string> {
	const endpoints = await discoverDeviceEndpoints(configuration.issuerUrl);
	const challenge = await requestDeviceCode(
		endpoints.deviceAuthorizationUrl,
		configuration.clientId,
	);
	const verificationUrl =
		challenge.verification_uri_complete ?? challenge.verification_uri;
	process.stdout.write(
		"Sign in to Iteration in your browser and confirm this code.\n" +
			"Code: " +
			challenge.user_code +
			"\n" +
			"Link: " +
			verificationUrl +
			"\n",
	);
	await openBrowser(verificationUrl);
	return pollForAccessToken(
		endpoints.tokenUrl,
		configuration.clientId,
		challenge.device_code,
		challenge.expires_in,
		challenge.interval,
	);
}

async function enrollDevice(
	endpoint: URL,
	accessToken: string,
	deviceName: string,
	organizationId: string | null,
	source: CollectorSource,
): Promise<EnrollmentResult> {
	const body: {
		deviceName: string;
		organizationId?: string;
		source?: CollectorSource;
	} = { deviceName };
	if (source !== "codex") body.source = source;
	if (organizationId !== null) body.organizationId = organizationId;
	const response = await collectorFetch(
		apiRoute(endpoint, "./collector-auth/enroll"),
		{
			method: "POST",
			headers: {
				Authorization: "Bearer " + accessToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		},
	);
	const payload = await responseJson(response);
	const parsed = parseCollectorEnrollmentResponse(payload);
	if (response.ok && parsed.success) return parsed.value;
	const error = z.object({ error: z.string().min(1) }).safeParse(payload);
	if (error.success) {
		throw new Error(error.data.error);
	}
	throw new Error(
		"The Iteration server returned an invalid enrollment response.",
	);
}

async function chooseOrganization(
	organizations: Extract<
		EnrollmentResult,
		{ status: "choose_organization" }
	>["organizations"],
	hasMore: boolean,
): Promise<string> {
	process.stdout.write("Choose an Iteration workspace for this collector:\n");
	for (const [index, organization] of organizations.entries()) {
		process.stdout.write(
			index + 1 + ". " + organization.name + " (" + organization.id + ")\n",
		);
	}
	if (hasMore) {
		process.stdout.write(
			"More workspaces exist; enter an organization ID to choose one not listed.\n",
		);
	}
	if (process.stdin.isTTY !== true) {
		throw new Error("Run iteration interactively or pass --workspace.");
	}
	const prompt = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = await prompt.question(
			"Workspace number or organization ID: ",
		);
		const id = z.uuid().safeParse(answer.trim());
		if (id.success) return id.data;
		const selection = z.coerce
			.number()
			.int()
			.min(1)
			.max(organizations.length)
			.safeParse(answer.trim());
		if (!selection.success) {
			throw new Error(
				"Choose a listed number or enter a valid organization ID.",
			);
		}
		const organization = organizations[selection.data - 1];
		if (organization === undefined) {
			throw new Error("The selected workspace is not available.");
		}
		return organization.id;
	} finally {
		prompt.close();
	}
}

export async function authenticateAndEnrollCollector(
	endpoint: URL,
	deviceNameValue: string,
	organizationId: string | null,
	source: CollectorSource = "codex",
): Promise<
	Readonly<{
		token: string;
		deviceId: string;
		organizationId: string;
		organizationName: string;
	}>
> {
	const deviceName = z
		.string()
		.trim()
		.min(1)
		.max(160)
		.safeParse(deviceNameValue);
	if (!deviceName.success) {
		throw new Error("--device-name must contain 1 to 160 characters.");
	}
	const configuration = await loadOAuthConfiguration(endpoint);
	const clerkAccessToken = await clerkDeviceSignIn(configuration);
	let result = await enrollDevice(
		endpoint,
		clerkAccessToken,
		deviceName.data,
		organizationId,
		source,
	);
	if (result.status === "choose_organization") {
		const selectedOrganizationId = await chooseOrganization(
			result.organizations,
			result.hasMore,
		);
		result = await enrollDevice(
			endpoint,
			clerkAccessToken,
			deviceName.data,
			selectedOrganizationId,
			source,
		);
	}
	if (result.status !== "enrolled") {
		throw new Error("The collector could not be assigned to that workspace.");
	}
	return {
		token: result.token,
		deviceId: result.deviceId,
		organizationId: result.organizationId,
		organizationName: result.organizationName,
	};
}
