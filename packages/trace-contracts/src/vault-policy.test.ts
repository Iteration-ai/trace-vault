import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canonicalRepository,
	permitsVaultCapture,
	vaultAccountReference,
	type VaultCapturePolicy,
} from "./vault-policy.ts";

test("repository rules match transport variants and round-trip canonical repositories", () => {
	for (const remote of [
		"git@GitHub.com:Example/Project.git",
		"https://github.com/example/project",
		"ssh://git@github.com/Example/Project.git",
		"github.com/example/project",
	]) {
		assert.equal(canonicalRepository(remote), "github.com/example/project");
	}
	assert.equal(
		canonicalRepository("gitlab.example:8443/Group/Repo"),
		"gitlab.example:8443/Group/Repo",
	);
	assert.equal(
		canonicalRepository("https://gitlab.example/Group/Repo.git"),
		"gitlab.example/Group/Repo",
	);
	for (const remote of [
		"/tmp/project",
		"file:///tmp/project",
		"https://secret:token@github.com/example/project",
		"https://github.com/example/project?token=secret",
		"nonsense",
	])
		assert.equal(canonicalRepository(remote), null);
});

test("capture accepts any approved basis but never a stale revision or a different principal", () => {
	const account = {
		source: "claude" as const,
		accountId: "work",
		organizationId: "company",
	};
	const policy: VaultCapturePolicy = {
		revision: 7,
		repositories: ["github.com/company/project"],
		accounts: [account],
		locations: ["/work/research"],
	};
	assert.equal(
		permitsVaultCapture(policy, {
			revision: 7,
			basis: "repository",
			reference: "github.com/company/project",
		}),
		true,
	);
	assert.equal(
		permitsVaultCapture(policy, {
			revision: 7,
			basis: "location",
			reference: "/work/research",
		}),
		true,
	);
	assert.equal(
		permitsVaultCapture(policy, {
			revision: 7,
			basis: "account",
			reference: vaultAccountReference(account),
		}),
		true,
	);
	assert.equal(
		permitsVaultCapture(policy, {
			revision: 6,
			basis: "repository",
			reference: "github.com/company/project",
		}),
		false,
	);
	assert.equal(
		permitsVaultCapture(policy, {
			revision: 7,
			basis: "account",
			reference: vaultAccountReference({
				...account,
				organizationId: "personal",
			}),
		}),
		false,
	);
	assert.equal(
		permitsVaultCapture(policy, {
			revision: 7,
			basis: "repository",
			reference: "github.com/company/project-copy",
		}),
		false,
	);
});
