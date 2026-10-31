import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const checker = fileURLToPath(
	new URL("../scripts/check-boundaries.mjs", import.meta.url),
);

test("public source accepts trace evidence but rejects consumer code, contracts and SQL", async (context) => {
	const root = await mkdtemp(path.join(tmpdir(), "vault-boundary-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const directory = path.join(root, "packages", "fixture");
	await mkdir(directory, { recursive: true });
	const filename = path.join(directory, "source.ts");
	const run = () =>
		spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
	await writeFile(
		filename,
		'export const evidence = { toolFailed: true, usageOutputTokens: 17, parentRunId: "parent" };',
	);
	assert.equal(run().status, 0);
	for (const source of [
		'import { login } from "@clerk/client";',
		'const endpoint = "https://useiteration.com/api/traces/ingest";',
		'import { command } from "iteration-cli";',
		'const endpoint = "/api/traces/friction-summary";',
		"export const collectorEnrollmentRequestSchema = {};",
		'const sql = "CREATE FUNCTION trace_tool_activity()";',
		'const columns = ["billing_kind", "usage_after_error"];',
	]) {
		await writeFile(filename, source);
		const result = run();
		assert.equal(result.status, 1, source);
		assert.match(
			result.stderr,
			/keep consumer-specific integration outside Trace Vault/,
		);
	}
});
