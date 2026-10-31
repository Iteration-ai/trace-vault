# Operating a Trace Vault

Run these commands from the standalone repository root. Examples use `.env`
and the default Compose project. Add the same `--project-name` to every command
if your deployment uses one. Never point rehearsals at a shared database.

## Before exposing a deployment

- Set independent random database and bootstrap secrets using `openssl rand -hex 32`.
  Use hex for the database password: Compose embeds it in a PostgreSQL URL.
- Protect `.env` with owner-only permissions and keep it outside version control.
- Set `VAULT_PUBLIC_URL` to the exact externally visible HTTPS origin. Use a TLS
  reverse proxy; the application port binds to loopback and PostgreSQL has no
  published port. Do not change those bindings to bypass proxy setup.
- Create the first administrator using the bootstrap token. Setup cannot be
  repeated after initialization, even with that token. Keep a second active
  administrator and protect host/database operator credentials separately.
- Approve only company repositories and explicit directory/account scopes.
  Eligibility is account **OR** repository **OR** directory, not all three.
  Secret redaction is best effort; archives, exports and backups remain sensitive.

## Back up the entire database

NDJSON exports are evidence exports, **not database backups**. They omit
identities, rules, credentials, audit and deletion tombstones. Use a PostgreSQL
custom-format dump for a consistent database snapshot, including both the
`vault` and `vault_migrations` schemas. Do not back up only selected trace tables.

```sh
umask 077
mkdir -p backups
backup="backups/trace-vault-$(date -u +%Y%m%dT%H%M%SZ).dump"
if docker compose --env-file .env exec -T database \
  pg_dump -U trace_vault -d trace_vault --format=custom --no-owner --no-acl > "$backup.tmp"; then
  mv "$backup.tmp" "$backup"
else
  rm -f "$backup.tmp"
  exit 1
fi
```

Encrypt and copy successful backups to separately protected storage. A Docker
volume on the same host is not disaster recovery. Set backup frequency and
retention for your own loss budget; no automatic backup scheduler is installed.
Store the deployment's version/image digest, reverse-proxy configuration and
protected environment configuration separately. Periodically restore a backup;
a successful dump alone does not demonstrate recoverability.

## Restore into an empty, isolated deployment

Use a separate Compose project and fresh `.env.restore`, with new database and
bootstrap secrets, an unused loopback port and its matching `VAULT_PUBLIC_URL`.
Use the same server version that created the backup first. Do not overwrite a
running vault or use `pg_restore --clean` as an improvised recovery procedure.

```sh
docker compose --project-name vault-restore --env-file .env.restore up --detach --wait database
docker compose --project-name vault-restore --env-file .env.restore exec -T database \
  pg_restore -U trace_vault -d trace_vault --exit-on-error --no-owner --no-acl < backups/SELECTED.dump
docker compose --project-name vault-restore --env-file .env.restore up --detach --wait --no-build vault
```

Supply a locally built image or a published version in `VAULT_IMAGE` before the
last command. If restore fails, do not start the app on the partially restored
database. Investigate and retry into another empty database. Reusing this project
does not create a fresh database if its volume already exists.

Check readiness, sign in, compare known exports, rules, member/device access and
audit history, and confirm deleted evidence stays deleted. A full backup restores
password hashes and still-valid sessions/device credentials as well as traces.
Keep the restored copy isolated; do not inadvertently expose duplicate access.
After restoring an older snapshot, review deletions and revocations made since
that snapshot before cutover: a backup cannot contain later security changes.

## Replace or upgrade the server

Back up and rehearse the target release on a restored copy first. Read its
migration/rollback notes; do not assume an old binary can use a migrated schema.
Never remove the PostgreSQL volume to upgrade.

For a source-built release, stop the old server, check out the reviewed version,
retain `.env` and run:

```sh
docker compose --env-file .env stop vault
docker compose --env-file .env build vault
docker compose --env-file .env up --detach --wait --no-build --force-recreate vault
```

After an image has actually been published, set `VAULT_IMAGE` to its exact
version (preferably digest), then `docker compose --env-file .env pull vault`
and use the same `up` command. Startup applies pending migrations before serving.
Check `/ready`, sign-in, a known export and collector acknowledgements afterward.
`docker compose down` preserves data; `down --volumes` destroys it.

Migration `0002_session_message_preview` scans retained user messages to backfill
missing session names. Allow a maintenance window for large archives: it runs
atomically before startup and leaves original source titles and events intact.

### Upgrading a 0.1.0 archive to the shared engine

Release 0.1.1 replaces the original vault storage with the same PostgreSQL engine
used by Iteration. **Stop every old vault process and take a backup first.** Do
not run old and new servers against the same database. Keep enough free disk for
the original archive and its replacement during conversion.

Startup renames the former tables, installs the canonical projection functions,
then replays the archive in committed batches of 50 events. Progress is recorded
with each batch; restart the same version after an interruption to resume. The
server does not accept traffic until conversion and verification finish.

Public session/event UUIDs, original envelopes, capture proofs, enrolled-device
attribution, receipt timestamps and source-scoped deletions are preserved.
Native member permissions and capture rules do not change. Legacy textual
project IDs remain in export/presentation metadata rather than being cast to
UUIDs. Counts and reconstructed envelopes are checked before the former raw
tables are removed; there is no second live trace store or dual writing.

Streaming usage now accepts improved reports under an existing event ID without
inflating event counts. Ordinary retries remain first-write-wins. Session names,
source metadata and user-message fallbacks are projected by the shared engine.

**Rollback requires restoring the pre-upgrade backup into a fresh database and
running 0.1.0 against that restored database.** Never start 0.1.0 against an
upgraded or partially upgraded database. Rehearse this upgrade on an isolated
restored copy before touching the live archive. The database suite exercises a
populated former schema, forced interruption, resume, unchanged public exports,
stable public links and retained tombstones; the container rehearsal separately
covers fresh installation, replacement and backup/restore.

This upgrade baseline is the published `v0.1.0`, not an earlier unreleased PR
build. The engine SQL in those PR builds had a different checksum: startup must
reject it rather than overwrite the migration ledger. Restore the pre-PR backup
before upgrading. Retaining PR-only data requires a separately reviewed offline
migration; do not delete ledger rows or ignore checksum failures. See the
[engine compatibility contract](../packages/trace-postgres/README.md#release-and-upgrade-compatibility).

## Recover an existing administrator

Recovery is a **local operator action**, authorized by possession of the explicit
vault database connection. There is no public password-reset endpoint, bypass
password or bootstrap reopening. From a trusted private terminal:

```sh
docker compose --env-file .env exec vault \
  node dist/operator.js recover-admin --email admin@example.com
```

Enter and confirm a new 12–256-character password when prompted. Input is hidden.
The command atomically changes that administrator's password, revokes all of
their existing sign-in sessions and records `admin.password_recovered` without
the password. Sign in normally afterward. Other members, collectors, capture
rules and retained traces remain unchanged. Unknown addresses, ordinary members,
disabled administrators and uninitialized databases are rejected; recovery
cannot grant a role or re-enable an account.

For a non-container deployment, set `VAULT_DATABASE_URL` explicitly and run
`node packages/vault/dist/operator.js recover-admin --email admin@example.com`.
An inherited `DATABASE_URL` is ignored. `--password-stdin` supports protected
operator-owned files/private pipes for automation; see `--help`. Never put a
password in command arguments, environment variables, shell history or logs.
If you suspect compromise, review/revoke devices and invitations separately;
password recovery deliberately does not erase evidence or revoke collector tokens.

## Reproduce the release rehearsal

On Linux with Node/pnpm from the [setup guide](setup.md#build-the-collector), Docker Compose, `git` and the
util-linux `script` command installed:

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/rehearse.mjs
```

If Docker requires sudo, use `VAULT_REHEARSAL_SUDO=1 node scripts/rehearse.mjs`.
This builds the shipping image, installs the standalone collector tarball outside
the source workspace, smokes `trace-vault`, performs private interactive native
vault enrollment, imports synthetic history and ongoing records through the
standalone collector, and compares exports across replacement and a separate backup restore.
It also checks scope exclusion/redaction, read isolation, restored tombstones and
operator recovery. It uses random project names/ports and synthetic data only,
and removes its own containers, volumes and temporary files afterward. Failures
are nonzero; cleanup failures name the disposable project for inspection.
