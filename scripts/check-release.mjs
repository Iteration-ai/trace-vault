import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const tag = process.env.RELEASE_TAG;
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/);
assert.equal(
	process.env.GITHUB_REF,
	`refs/tags/${tag}`,
	"Run the release workflow on the matching version tag, not a branch.",
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
	"packages/vault-collector/package.json",
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
	await readFile("packages/vault-collector/package.json", "utf8"),
);
assert.equal(collector.name, "@useiteration/trace-vault-collector");
assert.deepEqual(collector.bin, { "trace-vault": "./dist/vault-cli.js" });
assert.equal(Object.keys(collector.dependencies ?? {}).length, 0);
const cli = JSON.parse(await readFile("packages/cli/package.json", "utf8"));
assert.equal(cli.name, "iteration-cli");
assert.match(cli.version, /^\d+\.\d+\.\d+$/);
assert.deepEqual(cli.bin, {
	iteration: "./dist/cli.js",
	"trace-vault": "./dist/vault-cli.js",
});
const contracts = JSON.parse(
	await readFile("packages/trace-contracts/package.json", "utf8"),
);
assert.equal(contracts.name, "iteration-trace-contracts");
assert.match(contracts.version, /^\d+\.\d+\.\d+$/);
assert.notEqual(contracts.private, true);
process.stdout.write(
	`Release preflight passed for ${tag} at ${taggedCommit}.\n`,
);
