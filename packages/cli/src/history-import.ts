import path from "node:path";
import type { CollectorSource } from "iteration-trace-contracts";
import {
	backgroundServiceStatus,
	installBackgroundService,
	uninstallBackgroundService,
} from "./background-service.js";
import { waitForCollectorLock } from "./service.js";
import {
	collectorSource,
	collectorSourceDirectory,
	historyImportSize,
	loadState,
	resetHistoryCursors,
	type CollectorConfig,
	type CollectorPaths,
} from "./storage.js";

type HistoryImportSize = Readonly<{ files: number; bytes: number }>;

export type HistoryImportControl = Readonly<{
	isRunning: () => Promise<boolean>;
	stop: () => Promise<void>;
	start: (directory: string) => Promise<unknown>;
	acquireLock: (paths: CollectorPaths) => Promise<() => Promise<void>>;
}>;

function backgroundControl(source: CollectorSource): HistoryImportControl {
	return {
		isRunning: () => backgroundServiceStatus(source),
		stop: () => uninstallBackgroundService(source),
		start: (directory) => installBackgroundService(directory, source),
		acquireLock: waitForCollectorLock,
	};
}

export async function importSourceHistory(
	config: CollectorConfig,
	paths: CollectorPaths,
	confirmed: boolean,
	control: HistoryImportControl = backgroundControl(collectorSource(config)),
): Promise<
	Readonly<{
		imported: boolean;
		size: HistoryImportSize;
		backgroundRunning: boolean | null;
	}>
> {
	const source = collectorSource(config);
	const directory = collectorSourceDirectory(config);
	const state = await loadState(paths);
	if (!state.initialized || state.sourceDirectory !== path.resolve(directory)) {
		throw new Error(
			`Connect the ${source} source before importing its history.`,
		);
	}
	const estimate = await historyImportSize(directory, source);
	if (!confirmed)
		return { imported: false, size: estimate, backgroundRunning: null };

	const wasRunning = await control.isRunning();
	let size: HistoryImportSize | null = null;
	let stopAttempted = false;
	let rewound = false;
	let failure: Readonly<{ error: unknown }> | null = null;
	try {
		if (wasRunning) {
			stopAttempted = true;
			await control.stop();
		}
		const releaseLock = await control.acquireLock(paths);
		try {
			size = await resetHistoryCursors(directory, paths, source);
			rewound = true;
		} finally {
			await releaseLock();
		}
	} catch (error) {
		failure = { error };
	}
	if (stopAttempted) {
		try {
			await control.start(config.dataDirectory);
		} catch (error) {
			throw new Error(
				rewound
					? `History checkpoints were rewound, but the collector could not restart. Run iteration start ${source} to resume uploads.`
					: `The collector could not be restored after a failed history import. Run iteration start ${source} to resume uploads.`,
				{
					cause: failure ? new AggregateError([failure.error, error]) : error,
				},
			);
		}
	}
	if (failure) throw failure.error;
	if (size === null) {
		throw new Error("History import did not update checkpoints.");
	}
	return { imported: true, size, backgroundRunning: wasRunning };
}
