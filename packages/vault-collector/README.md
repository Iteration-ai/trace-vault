# Trace Vault collector

`@useiteration/trace-vault-collector` is the independent Apache-2.0 collector for a
self-hosted Trace Vault. It requires Node.js 22.22.0 or later and installs only the
`trace-vault` executable. The bundled collector has no runtime npm dependencies;
no Iteration account or separately published contracts package is needed.

The published `0.1.0` package is installable from npm. To verify the next release
from source, build and pack from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @useiteration/trace-vault-collector build
pnpm pack:collector
pnpm smoke:collector
npm install --global ./artifacts/useiteration-trace-vault-collector-0.1.1.tgz --ignore-scripts
trace-vault --help
trace-vault connect claude --vault https://vault.example.com
trace-vault collect claude --vault https://vault.example.com
```

This package has no copied collection source: its build consumes
`../cli/src/vault-cli.ts` and the reusable `iteration-trace-collector` machinery.
That library exposes a [supported package API](../cli/README.md) for other hosts.
Neither this executable nor the public library contains the private Iteration
CLI's authentication, enrollment, commands, billing, friction summaries or
product-configured launcher/updater. Only the standalone collector package is
published by Trace Vault's public collector release workflow.

Use `codex` or `cursor` for those sources. Passwords and invitation tokens are
prompted privately. `collect` runs in the foreground; `--once` performs one bounded
scan/upload tick. No background service or automatic updater is installed.

Keep collector data on a local filesystem, not a network share. Stop older
collector processes before upgrading or rolling back; never delete
`collector.lock.sqlite` while a collector could be running. See the reusable
API's [lock and recovery contract](../cli/README.md) for details.

Explicit repository/location rules authorize existing history and ongoing
collection, not historical account ownership. Prospective account capture is
supported only for terminal Claude Code 2.1.282, following `account-setup`, a
Claude restart, live collection and `approve-account`. It is not historical
identity recovery. Codex/Cursor account capture and other Claude versions are
unsupported and fail closed; repository/location collection remains available.

Local secret redaction is best effort. Treat the collected archive as sensitive.
Read the standalone [setup guide](https://github.com/Iteration-ai/trace-vault/blob/main/docs/setup.md) for
deployment, permissions, evidence limitations and verification commands.
