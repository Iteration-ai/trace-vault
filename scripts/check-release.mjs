import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const tag = process.env.RELEASE_TAG;
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/);
assert.equal(
	process.env.GITHUB_REF,
	`refs/tags/${tag}`,
	"Dispatch the workflow on the existing release tag, not a branch.",
);
const taggedCommit = execFileSync(
	"git",
	["rev-parse", `refs/tags/${tag}^{commit}`],
	{ encoding: "utf8" },
).trim();
assert.equal(
	taggedCommit,
	process.env.GITHUB_SHA,
	"Tag must point at the verified workflow commit.",
);
for (const file of [
	"package.json",
	"packages/cli/package.json",
	"packages/vault/package.json",
]) {
	const manifest = JSON.parse(await readFile(file, "utf8"));
	assert.equal(
		`v${manifest.version}`,
		tag,
		`${file} version must match the release tag.`,
	);
}
const collector = JSON.parse(
	await readFile("packages/cli/package.json", "utf8"),
);
assert.equal(collector.name, "@iteration-ai/trace-vault-collector");
assert.deepEqual(collector.bin, { "trace-vault": "./dist/vault-cli.js" });
const contracts = JSON.parse(
	await readFile("packages/trace-contracts/package.json", "utf8"),
);
assert.equal(contracts.private, true);
process.stdout.write(
	`Release preflight passed for ${tag} at ${taggedCommit}.\n`,
);
