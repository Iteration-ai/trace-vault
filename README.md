# Trace Vault

A company-owned, self-hosted archive for coding-agent traces. Apache-2.0; no
Iteration account, learning product, subscription, model service or LLM API key.
The server includes the existing React management UI and stores retained traces
in PostgreSQL. Collectors run on the machines with the original Claude Code,
Codex and Cursor records.

Members browse their own sessions; administrators browse the company archive.
Collection requires explicitly approved repositories, directories or supported
contemporaneous account evidence. Unmatched originals stay on their machine.
Existing-history import and ongoing collection share those rules. Local secret
redaction is best effort: traces and backups remain sensitive company data.
Search, SSO and a managed service are not provided.

## Quickstart: build from source

**No npm package or container image has been published as part of this extraction.**
Use the source build below until an operator explicitly performs a release.

Install Docker with Compose v2.20+ (the root file uses Compose `include`), then:

```sh
cp packages/vault/.env.example .env
chmod 600 .env
openssl rand -hex 32
openssl rand -hex 32
# Put the two independent results in .env as VAULT_DATABASE_PASSWORD and
# VAULT_BOOTSTRAP_TOKEN. Never commit .env.
docker compose --env-file .env up --build --detach --wait
```

Open `http://localhost:4310` on the Docker host, supply the bootstrap token, and
create the first administrator. Add company repository rules and invite members.
The deployment contains only the vault and PostgreSQL; the database is not
published on a host port. The pinned Node 22.22.0 server runs as `node`, not root.

For remote access, set `VAULT_PUBLIC_URL` to the exact public HTTPS origin and
put your TLS reverse proxy in front of the loopback-only port. Do not expose
plain HTTP or PostgreSQL to the Internet. Keep the PostgreSQL volume across
upgrades and back it up first; startup applies the vault's migrations. Normal
shutdown is `docker compose --env-file .env down` (without `--volumes`).

### Build the collector

Use **Node 22.22.0** and **pnpm 10.20.0**, matching `.node-version` and the lockfile:

```sh
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm pack:collector
pnpm smoke:collector
npm install --global ./artifacts/thytu-trace-vault-collector-0.1.0.tgz --ignore-scripts
trace-vault --help
```

The collector tarball is self-contained, with no runtime npm dependencies or
install scripts. Its only executable is `trace-vault`; it does not install or
depend on `iteration-cli`. `iteration-trace-contracts` is an internal private
workspace used by the build, not a mandatory published package.

Run on each developer's machine, using the actual server origin:

```sh
trace-vault connect claude --vault https://vault.example.com
trace-vault collect claude --vault https://vault.example.com
```

Use `codex` or `cursor` for those sources, `--join` when accepting an invitation,
and `--location /absolute/company/work` to approve non-repository history.
Passwords and invitation tokens are entered privately. `collect` stays in the
foreground; `--once` performs one bounded scan/upload tick. Use your process
supervisor if continuous collection is required; no startup service or automatic
package updater is installed by this entry point.

Repository/directory approval includes historical content and is **not proof of
which account generated it**. Cursor records without per-record workspace
evidence require an explicitly approved transcript-storage root.

Optional prospective account capture supports **terminal Claude Code 2.1.282
only**: run `trace-vault account-setup claude --vault https://vault.example.com`,
approve the settings change, restart Claude, keep collection running, submit a
request, then run `trace-vault approve-account claude --vault
https://vault.example.com` in another terminal. This selects an actually observed
account and organization; it cannot recover historical identity. Other Claude
versions and Codex/Cursor account capture are unsupported and fail closed.
Repository/location collection remains available for all three sources. See
`trace-vault --help` for the exact evidence and bounded-ledger contracts.

### Without Docker

After building, provide explicit `VAULT_DATABASE_URL`, `VAULT_PUBLIC_URL` and
`VAULT_BOOTSTRAP_TOKEN` (at least 32 random characters), then run `pnpm start`.
The database must be PostgreSQL 17 with permission to create the vault schema.
No inherited `DATABASE_URL` is used. See the [vault guide](packages/vault/README.md)
for authentication, data ownership, permissions and HTTP contracts.

## Verification

`pnpm test` runs the copied contract and collector tests plus vault tests. Vault
database/HTTP tests require an explicit **disposable local PostgreSQL 17** URL
whose role can create/drop databases; without it those tests skip. Never point
tests at a retained archive. Each database test creates and drops a random database:

```sh
VAULT_TEST_DATABASE_URL=postgresql://vault_test:vault_test@127.0.0.1:5432/vault_test pnpm test
```

CI performs frozen install, build, all workspace/shared types, tests against
disposable pinned PostgreSQL 17.11, offline installation of the packed collector,
and Docker build/nonroot runtime/readiness checks with a second disposable DB.
Test containers/volumes are deleted afterwards. CI never publishes.

The [operations guide](docs/operations.md) covers complete PostgreSQL backups,
isolated restoration, server replacement, administrator recovery and the actual
shipping-container/installed-collector rehearsal (`node scripts/rehearse.mjs`).
The initial release has no predecessor; same-version replacement is verified,
not a claim of compatibility with a previously released vault schema.

## Releases (operator-controlled)

The intended package is `@thytu/trace-vault-collector@0.1.0`; the intended image
is `ghcr.io/iteration-ai/trace-vault:v0.1.0` (Linux amd64). Neither exists by virtue of
adding these workflows. `VAULT_IMAGE` selects a release image; the default is
`trace-vault:local`. After a verified release, use `VAULT_IMAGE` with Compose
`pull` and `up --no-build --detach --wait` rather than rebuilding that tag.

Before any publication, repository administrators must:

1. Create the GitHub **`release` environment**, require an approving reviewer,
   disallow self-approval and restrict deployment refs to release tags. Protect
   release tags against mutation. The workflow names an environment but cannot
   itself configure GitHub's approval policy; do not dispatch until this is set.
2. Configure npm trusted publishing for `@thytu/trace-vault-collector`, repository
   `Iteration-ai/trace-vault`, workflow `release.yml`, environment `release`. This uses
   OIDC (`id-token: write`) with npm 11.19.1, not a stored npm token. If npm cannot
   configure a trusted publisher before the package exists, an authorized npm
   owner must separately bootstrap package ownership before this workflow is
   usable. No bootstrap publication is automated here.
3. Enable the repository's `GITHUB_TOKEN` permission to publish its GHCR package.
   Set package visibility deliberately if anonymous pulls are intended.

An operator updates root, collector and server versions together, creates the
matching existing `vX.Y.Z` tag, then manually dispatches **Release** with both the
workflow ref and `tag` input set to that tag. Initial push and tag creation only
run verification; **publication is never triggered by either**. Preflight rejects
branch dispatch and tag/version/SHA mismatches. Builds, tests and container health
must pass before approval. After approval, checksums and image identity/revision
are rechecked and the exact tested tarball/image are published, followed by a
GitHub release. Contracts are never published. Tags are versioned, not `latest`.

Registries are separate systems: npm, GHCR and GitHub publication is not atomic.
If a later step fails, inspect the actual published state before retrying; never
reuse a version with different bytes or assume that a failed job published nothing.

## License and contribution

See [LICENSE](LICENSE), [NOTICE](NOTICE), [provenance](OPEN-SOURCE.md),
[security reporting](SECURITY.md) and [contributing](CONTRIBUTING.md).
Only the licensed shared/vault paths were extracted from the original working
tree; no private application source, history, credentials or production data is
part of this repository.
