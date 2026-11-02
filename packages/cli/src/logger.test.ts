import assert from "node:assert/strict";
import { test } from "node:test";
import { collectorLogger, configureCollectorLogging } from "./index.js";

test("a configured writer receives every collector log line instead of the console", (context) => {
	const lines: [string, string][] = [];
	const printed: unknown[] = [];
	context.mock.method(console, "info", (line: unknown) => printed.push(line));
	context.mock.method(console, "error", (line: unknown) => printed.push(line));
	context.after(() => configureCollectorLogging(() => ({})));
	configureCollectorLogging(
		() => ({ runtimeVersion: "1.2.3" }),
		(line, level) => lines.push([level, line]),
	);
	collectorLogger({ level: "info", operation: "http_request", status: 200 });
	collectorLogger({ level: "error", operation: "http_request" });
	assert.deepEqual(printed, []);
	assert.deepEqual(
		lines.map(([level, line]) => [level, JSON.parse(line).runtimeVersion]),
		[
			["info", "1.2.3"],
			["error", "1.2.3"],
		],
	);
	configureCollectorLogging(() => ({}));
	collectorLogger({ level: "info", operation: "http_request" });
	assert.equal(printed.length, 1);
});
