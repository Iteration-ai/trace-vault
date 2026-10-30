type LogValue =
	| string
	| number
	| boolean
	| null
	| readonly LogValue[]
	| { readonly [key: string]: LogValue };

type LogLevel = "info" | "warning" | "error";
type LogEntry = Readonly<{
	level: LogLevel;
	operation: string;
	[key: string]: LogValue | undefined;
}>;
type LogContext = Readonly<{ component: string; source?: string }>;
type LogWriter = (line: string, level: LogLevel) => void;

function writeLog(line: string, level: LogLevel): void {
	if (level === "info") console.info(line);
	else console.error(line);
}

export function createLogger(
	context: LogContext,
	write: LogWriter = writeLog,
): (entry: LogEntry) => void {
	return (entry) => {
		write(
			JSON.stringify({
				...entry,
				...context,
				at: new Date().toISOString(),
				pid: process.pid,
				runtimeVersion: process.env.ITERATION_RUNTIME_VERSION ?? null,
			}),
			entry.level,
		);
	};
}

export const collectorLogger = createLogger({ component: "collector" });
