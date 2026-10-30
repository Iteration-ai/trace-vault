import {
	vaultCapturePolicySchema,
	type VaultCapturePolicy,
} from "iteration-trace-contracts";
import { collectorFetch, type CollectorFetcher } from "./collector-fetch.js";
import { validateCollectorEndpoint } from "./storage.js";

export function vaultOrigin(value: string): string {
	const url = new URL(value);
	if (url.pathname !== "/" || url.search || url.hash)
		throw new Error(
			"Company vault URL must be a base origin without a path or query.",
		);
	validateCollectorEndpoint(new URL("/api/traces/ingest", url).href);
	return url.origin;
}

export async function vaultRequest(
	origin: string,
	route: string,
	token: string | null,
	method: "GET" | "POST" | "PUT",
	body?: unknown,
	fetcher: CollectorFetcher = collectorFetch,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetcher(new URL(route, vaultOrigin(origin)), {
		method,
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
			: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			`Company vault ${method} ${route} failed with HTTP ${response.status}.`,
		);
	}
	try {
		return await response.json();
	} catch {
		throw new Error(`Company vault ${route} returned invalid JSON.`);
	}
}

export async function fetchVaultPolicy(
	endpoint: string,
	token: string,
	fetcher: CollectorFetcher = collectorFetch,
	signal?: AbortSignal,
): Promise<VaultCapturePolicy> {
	const value = await vaultRequest(
		new URL(endpoint).origin,
		"/api/collector/policy",
		token,
		"GET",
		undefined,
		fetcher,
		signal,
	);
	const parsed = vaultCapturePolicySchema.safeParse(value);
	if (!parsed.success)
		throw new Error("Company vault returned an invalid capture policy.");
	return parsed.data;
}
