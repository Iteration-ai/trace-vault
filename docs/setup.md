# Self-hosting Trace Vault

Run these commands from the repository root. Collectors run on the machines
containing the original Claude Code, Codex and Cursor records; the server stores
the approved archive in PostgreSQL. Members browse their own sessions and
administrators browse the company archive. Search, SSO and a managed service
are not provided.

Collection requires explicitly approved repositories, directories or supported
contemporaneous account evidence. Unmatched originals stay on their machine.
Existing-history import and ongoing collection share those rules. Local secret
redaction is best effort: traces and backups remain sensitive company data.

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
npm install --global ./artifacts/useiteration-trace-vault-collector-0.1.0.tgz --ignore-scripts
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
No inherited `DATABASE_URL` is used. See the [vault guide](../packages/vault/README.md)
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

The [operations guide](operations.md) covers complete PostgreSQL backups,
isolated restoration, server replacement, administrator recovery and the actual
shipping-container/installed-collector rehearsal (`node scripts/rehearse.mjs`).
The initial release has no predecessor; same-version replacement is verified,
not a claim of compatibility with a previously released vault schema.

## Releases (automatic on version tags)

The intended package is `@useiteration/trace-vault-collector@0.1.0`; the intended image
is `ghcr.io/iteration-ai/trace-vault:v0.1.0` (Linux amd64). Neither exists by virtue of
adding these workflows. `VAULT_IMAGE` selects a release image; the default is
`trace-vault:local`. After a verified release, use `VAULT_IMAGE` with Compose
`pull` and `up --no-build --detach --wait` rather than rebuilding that tag.

### One-time npm setup

1. Sign in to npm with an account that can publish under the `@useiteration` scope.
   GitHub organization ownership does not grant npm scope ownership.
2. In npm, open **Access Tokens → Generate New Token**. Name it `trace-vault-release`.
   Under **Packages and scopes**, choose **Read and write (publish and stage)**,
   then **Only select packages and scopes** and select the `@useiteration` scope.
   Enable **Bypass two-factor authentication** for unattended publishing. Leave
   organization-management access disabled. Choose an expiry and rotate the token
   before it expires. See [npm's token guide](https://docs.npmjs.com/creating-and-viewing-access-tokens).
3. Open the repository's **Settings → Secrets and variables → Actions → New
   repository secret**. Set the name to `NPM_TOKEN` and paste the token as its value.
   Never put this token in a commit, command argument or issue/thread message.

This token can publish the first package version as well as later versions; there
is no separate package-bootstrap publish, npm trusted-publisher setup or release
environment approval step. The repository must be public for npm provenance.
GitHub releases and GHCR use the workflow's built-in `GITHUB_TOKEN`, not a personal
GitHub token. The publish job requests only contents/packages write and OIDC for
provenance. For anonymous image pulls, set the GHCR package's visibility to public
after its first publication; public repository visibility alone does not do that.

### Publish a version

Update the root, collector and server versions together, then commit and push the
reviewed changes to `main`. Push the matching `vX.Y.Z` tag. For the initial version:

```sh
git tag -a v0.1.0 -m "Trace Vault v0.1.0"
git push origin v0.1.0
```

**Pushing the version tag starts publication automatically.** Branch pushes only
run verification. Preflight rejects branch dispatch, invalid tags, version/SHA
mismatches and missing/invalid npm credentials before the full build. All builds,
tests, secret scanning, packaged-collector checks and container rehearsals must
pass. Checksums and image identity/revision are then rechecked before publishing
the tested collector, container and GitHub release. Contracts are never published.
There is no additional manual approval after the tag push. Restrict tag creation
to trusted maintainers using repository rules where available, and never move or
delete a published version tag. Container tags are versioned, not `latest`.

Manual **Release** dispatch remains available on an existing version tag: both the
workflow ref and `tag` input must select that tag. Do not use it to blindly retry a
partially successful publication.

Registries are separate systems: npm, GHCR and GitHub publication is not atomic.
If a later step fails, inspect the actual published state before retrying; never
reuse a version with different bytes or assume that a failed job published nothing.

## License and contribution

See [LICENSE](../LICENSE), [NOTICE](../NOTICE), [provenance](../OPEN-SOURCE.md),
[security reporting](../SECURITY.md) and [contributing](../CONTRIBUTING.md).
Only the licensed shared/vault paths were extracted from the original working
tree; no private application source, history, credentials or production data is
part of this repository.
