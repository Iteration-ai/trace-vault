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
export type LogWriter = (line: string, level: LogLevel) => void;

function consoleWriter(line: string, level: LogLevel): void {
	if (level === "info") console.info(line);
	else console.error(line);
}

let loggingContext: () => Readonly<Record<string, LogValue>> = () => ({});
let logWriter: LogWriter = consoleWriter;

// A consumer's interactive commands can send logs elsewhere, so JSON lines
// never interleave with the messages a person reads in the terminal.
export function configureCollectorLogging(
	context: () => Readonly<Record<string, LogValue>>,
	write: LogWriter = consoleWriter,
): void {
	loggingContext = context;
	logWriter = write;
}

function writeLog(line: string, level: LogLevel): void {
	logWriter(line, level);
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
				...loggingContext(),
			}),
			entry.level,
		);
	};
}

export const collectorLogger = createLogger({ component: "collector" });
