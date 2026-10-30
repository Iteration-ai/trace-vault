# Iteration CLI

`iteration-cli` is the canonical Apache-2.0 collector CLI for Iteration and Trace
Vault. It requires Node.js 22 or later. Both executables are bundled with no
runtime npm dependencies:

- `iteration` connects to an Iteration workspace, imports history, installs
  background collection and manages automatic updates and rollback.
- `trace-vault` connects directly to a self-hosted vault without an Iteration
  account. It collects in the foreground and does not install startup services
  or an automatic updater.

Build and pack from this repository's root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack:cli
pnpm smoke:cli
npm install --global ./artifacts/iteration-cli-0.14.4.tgz --ignore-scripts
iteration --help
iteration connect
iteration status
iteration version
trace-vault --help
```

The package ships `dist/cli.js`, `dist/launcher.js`, `dist/cursor-hook-entry.js`
and `dist/vault-cli.js`. The managed runtime copies the installed package to
`~/.config/iteration/runtime`; background services and hooks use its launcher so
global npm replacement cannot interrupt collection. Updates still resolve
`iteration-cli` from npm, verify and trial a candidate, and roll back repeated
startup failures. `iteration update off|on` controls automatic updates.

There is exactly one collector source tree here and one contracts source tree in
`../trace-contracts`. The [standalone collector](../vault-collector/README.md)
builds only `src/vault-cli.ts`, without copying it or any shared implementation.
Use that package if you want only the `trace-vault` executable. Both packages
provide that executable; install them separately rather than depending on global
npm bin collision order.

Trace Vault's public release workflow does **not** publish `iteration-cli` or
`iteration-trace-contracts`. Iteration's publisher publishes those packages from
the same SHA-pinned canonical source. Their versions evolve independently of
Trace Vault's server/standalone collector release family.
