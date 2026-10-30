# Contributing

Keep Trace Vault independent, self-hostable and Apache-2.0. Do not add learning
product, account-provider or hosted-service requirements to the vault entrypoint.
The separate `iteration` entrypoint retains its Iteration workspace integration.
Preserve capture
authorization, local redaction, member/admin boundaries and fail-closed handling
of unsupported account evidence.

Use Node 22.22.0 and pnpm 10.20.0. Run frozen install, `pnpm build`,
`pnpm typecheck`, `pnpm test`, `pnpm pack:collector`, `pnpm smoke:collector`,
`pnpm pack:cli`, `pnpm smoke:cli`, `pnpm pack:contracts`, `pnpm smoke:contracts`
and `pnpm smoke:published`.
Supply a disposable local PostgreSQL 17 URL as `VAULT_TEST_DATABASE_URL` so vault
tests actually run; see [verification](docs/setup.md#verification).
Include focused behavioral tests for changes.
Never use production data or credentials in fixtures.

Preserve exact dependency pins and regenerate `pnpm-lock.yaml` with pnpm when
dependencies change. Keep both collectors bundled with no runtime npm dependencies,
one canonical CLI/contracts source tree, third-party notices intact, and public publication restricted to
explicit version tags after all release checks pass. Pushing a version tag publishes;
ordinary branch pushes do not.
The public workflow publishes only `@useiteration/trace-vault-collector`, the
server image and GitHub release. Iteration's publisher owns `iteration-cli` and
`iteration-trace-contracts`; do not publish them from the public workflow.
Changes are submitted as pull requests; submitting a contribution makes it
available under the project's Apache-2.0 license. Security issues follow
[SECURITY.md](SECURITY.md), not public issue reports.
