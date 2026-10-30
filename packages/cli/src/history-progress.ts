import type { CollectorHistoryProgress } from "iteration-trace-contracts";
import type { CollectorFetcher } from "./collector-fetch.js";
import type { CollectorConfig } from "./storage.js";

const REQUEST_TIMEOUT_MS = 15_000;
// A tick can read a few more sessions each time; reporting each one would add
// a request per tick for a change nobody sees.
const REPORT_INTERVAL_MS = 10_000;

class HistoryProgressError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "HistoryProgressError";
	}
}

function unchanged(
	left: CollectorHistoryProgress,
	right: CollectorHistoryProgress | null,
): boolean {
	return (
		right !== null &&
		left.sessions === right.sessions &&
		left.readSessions === right.readSessions &&
		left.complete === right.complete
	);
}

// Reports the import of saved sessions until it completes once. Sessions
// that start afterwards are ordinary new activity.
export class HistoryProgressReporter {
	#sent: CollectorHistoryProgress | null = null;
	#sentAtMs = Number.NEGATIVE_INFINITY;
	#completed = false;

	async report(
		config: CollectorConfig,
		progress: CollectorHistoryProgress,
		fetcher: CollectorFetcher,
		signal: AbortSignal,
		nowMs: number,
	): Promise<void> {
		if (this.#completed || unchanged(progress, this.#sent)) return;
		if (!progress.complete && nowMs - this.#sentAtMs < REPORT_INTERVAL_MS)
			return;
		let response: Response;
		try {
			response = await fetcher(
				new URL("/api/traces/collector-progress", config.endpoint),
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${config.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(progress),
					signal: AbortSignal.any([
						signal,
						AbortSignal.timeout(REQUEST_TIMEOUT_MS),
					]),
				},
			);
		} catch (error) {
			if (signal.aborted) throw error;
			throw new HistoryProgressError(
				"History progress could not reach Iteration.",
				{ cause: error },
			);
		}
		if (response.status !== 204) {
			throw new HistoryProgressError(
				`History progress failed with HTTP ${response.status}.`,
			);
		}
		this.#sent = progress;
		this.#sentAtMs = nowMs;
		this.#completed = progress.complete;
	}
}
