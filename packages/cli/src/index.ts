export {
	CLAUDE_ACCOUNT_VERSION,
	type ClaudeAccountEvidence,
	ClaudeAccountIndex,
	type ClaudeAccountLedger,
	claudeCaptureIdentity,
	loadClaudeAccountLedger,
	saveClaudeAccountEvidence,
} from "./claude-account.js";
export {
	claudeMetadataFromOtlp,
	startClaudeAccountReceiver,
} from "./claude-account-receiver.js";
export {
	approveClaudeAccount,
	setupClaudeAccount,
	startConfiguredClaudeReceiver,
} from "./claude-account-setup.js";
export {
	captureClaudeGit,
	claudeGitHookFailureAtMs,
	claudeGitHookFiles,
	claudeGitHookPaths,
	recordClaudeGitHookFailure,
} from "./claude-git-hook.js";
export {
	type ClaudeParseResult,
	parseClaudeGitHookLine,
	parseClaudeLine,
} from "./claude-transcript.js";
export {
	collectorTick,
	type HistoryProgress,
	scanSourceOnce,
	TraceUploadError,
} from "./collector.js";
export { type CollectorFetcher, collectorFetch } from "./collector-fetch.js";
export {
	acquireCollectorLock,
	waitForCollectorLock,
} from "./collector-lock.js";
export {
	CURSOR_HOOKS,
	cursorHookDirectory,
	cursorHookFailureAtMs,
	cursorHookFailurePath,
	cursorHookFiles,
} from "./cursor-hook-queue.js";
export {
	parseCursorHookLine,
	parseCursorTranscriptLine,
} from "./cursor-transcript.js";
export { gitBranch, gitRepositoryUrl } from "./git-repository.js";
export {
	collectorLogger,
	configureCollectorLogging,
	createLogger,
} from "./logger.js";
export { ensurePrivateDirectory } from "./private-storage.js";
export { redactTraceEvent } from "./redact-trace.js";
export { parseRolloutLine, type RolloutParseResult } from "./rollout.js";
export { sourceHome } from "./source-home.js";
export {
	acknowledgeEvents,
	appendEvents,
	assertFreshCollectorDirectory,
	type CollectorConfig,
	type CollectorFailure,
	type CollectorHealth,
	type CollectorPaths,
	type CollectorState,
	claudeFiles,
	collectorPaths,
	collectorSource,
	collectorSourceDirectory,
	countSavedSessions,
	cursorFiles,
	ensureClaudeHistoryBackfill,
	ensureCursorHistoryBackfill,
	ensureHistoryBackfill,
	ensureStartableState,
	type HealthSnapshot,
	healthSnapshot,
	historyImportSize,
	historyScanProgress,
	initializeState,
	loadConfig,
	loadHealth,
	loadState,
	nextBatch,
	outboxSize,
	pendingEventIds,
	prepareSourceInitialState,
	redactPendingOutbox,
	resetHistoryCursors,
	rewritePendingEvents,
	type SourceFile,
	saveConfig,
	saveHealth,
	saveState,
	sourceFiles,
	sourceFilesNewestFirst,
	validateCollectorEndpoint,
} from "./storage.js";
export { fetchVaultPolicy, vaultOrigin, vaultRequest } from "./vault-api.js";
export {
	defaultVaultDirectory,
	enrollVault,
	type VaultPrompts,
	vaultMemberLogin,
} from "./vault-enrollment.js";
export {
	authorizeVaultRecord,
	reauthorizeVaultEvent,
	resolveCaptureLocation,
	scopeVaultEvents,
} from "./vault-scope.js";
export {
	encodedPowerShell,
	powershellLiteral,
	runWindowsPowerShell,
	windowsArgument,
	windowsHookArguments,
	windowsHookInvocation,
	windowsPowerShellPath,
} from "./windows-powershell.js";
