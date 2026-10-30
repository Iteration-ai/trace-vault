# Trace Vault collector

`@useiteration/trace-vault-collector` is the independent Apache-2.0 collector for a
self-hosted Trace Vault. It requires Node.js 22 or later and installs only the
`trace-vault` executable. The bundled collector has no runtime npm dependencies;
no Iteration account or separately published contracts package is needed.

The published `0.1.0` package is installable from npm. To verify the next release
from source, build and pack from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack:collector
npm install --global ./artifacts/useiteration-trace-vault-collector-0.1.1.tgz --ignore-scripts
trace-vault --help
trace-vault connect claude --vault https://vault.example.com
trace-vault collect claude --vault https://vault.example.com
```

This package has no copied source: its build consumes
`../cli/src/vault-cli.ts` and shared modules from the canonical `iteration-cli`
package. It does not install or depend on that npm package or the published
contracts package. Only this collector package is published by Trace Vault's
public release workflow; Iteration's own publisher owns the other two packages.

Use `codex` or `cursor` for those sources. Passwords and invitation tokens are
prompted privately. `collect` runs in the foreground; `--once` performs one bounded
scan/upload tick. No background service or automatic updater is installed.

Explicit repository/location rules authorize existing history and ongoing
collection, not historical account ownership. Prospective account capture is
supported only for terminal Claude Code 2.1.282, following `account-setup`, a
Claude restart, live collection and `approve-account`. It is not historical
identity recovery. Codex/Cursor account capture and other Claude versions are
unsupported and fail closed; repository/location collection remains available.

Local secret redaction is best effort. Treat the collected archive as sensitive.
Read the standalone [setup guide](https://github.com/Iteration-ai/trace-vault/blob/main/docs/setup.md) for
deployment, permissions, evidence limitations and verification commands.
