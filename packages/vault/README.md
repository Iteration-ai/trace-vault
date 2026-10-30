# Trace Vault

One company-owned archive for coding-agent traces. Self-hosted, Apache-2.0,
independent of Iteration, with no LLM service or API key required. This package
stores and serves evidence; it does not learn from it. Search is a separate
workstream and is not implemented here.

## What is implemented

- Local administrator bootstrap; password sign-in; single-use, expiring invitations.
- One company archive, with per-member collection permissions and device credentials.
- Full eligible source records, with local secret redaction before queuing. Redaction
  cannot guarantee that every secret is detected; the archive is still sensitive.
- Existing-history import and ongoing collection, using the same eligibility rules.
- Repository matching through Git's shared worktree configuration and explicitly
  approved local directories for research or missing repositories.
- Member-only access to one's own sessions; administrators can browse everyone's.
  Collector credentials are upload/policy credentials, not archive-read credentials.
- Streaming NDJSON export, paginated sessions/events/members/devices/audit, device
  revocation, disabled-member retention, and deletion tombstones preventing reupload.

Session names prefer a captured title. Otherwise they use the first nonempty
user message, with whitespace collapsed and a 160-character limit. Sessions with
neither show “Untitled session”; original event payloads are unchanged.

The collector runs on the machine containing the original Claude Code, Codex or
Cursor files. Originals that do not match an approved rule stay there; they are
not uploaded into a second mandatory personal vault. Approving a directory or
repository authorizes historical content too. These scopes are explicit user
authorization, **not proof of which subscription generated historical messages**.
Mixed/inherited content must be considered before approving a scope.

The account rule contract is separate from repository/location rules. Current
login, email domain, session creator and saved account labels must never be used
to infer original-message ownership. Exact source-specific support is reported
by `trace-vault --help`; unsupported account evidence never silently broadens
collection. Neither an LLM nor a classifier decides whether a trace is work.

## Self-hosting

The repository's [setup guide](../../docs/setup.md#quickstart-build-from-source) owns build,
Docker, collector and verification commands. The Compose deployment contains only
the vault and PostgreSQL. It does not start Clerk, Vercel, Infisical, a vector
database or a model server. The Node runtime image is unprivileged and pinned by
version and digest.

Open the vault, enter the deployment bootstrap token and create the first admin.
The bootstrap route is permanently closed once initialized. Add company
repositories, invite colleagues, then have each colleague connect their local
collector to this vault. Invitation links contain a one-time token in their URL
fragment; distribute them privately. No mail provider is required.

Set `VAULT_PUBLIC_URL` to the exact externally visible HTTPS origin. Terminate TLS
at your existing reverse proxy and forward to the loopback port. Plain HTTP is
accepted only for local development. The application rejects foreign origins,
uses HttpOnly/SameSite cookies, and never trusts a proxy-supplied user identity.

## Data ownership and operations

The database is the company's retained archive. Disabling an employee or revoking
a collector stops access/uploads without deleting their retained traces. Members
can delete their own sessions, and administrators can delete any session; these
deletions are explicit, audited and tombstoned. There is no automatic retention
expiry in this version. Removing capture permission stops future upload; it does
not silently erase previously accepted company evidence.

Back up the PostgreSQL volume and protect backups with your normal encryption,
access and retention controls. Exports are NDJSON source events, not a complete
database backup. A running export reauthorizes each page and is bounded to five
minutes and one million records; it is not a transactional snapshot of concurrent
imports. An interrupted export closes its connection rather than silently
claiming completion. Exports use the browser's native download handling.

The service bounds bodies to 4 MiB, batches to 100 events, concurrent requests to
32, concurrent password operations to four and password attempts to twenty per
minute per connecting address. Behind a proxy that address can be shared; use
proxy-level admission controls for larger installations. PostgreSQL connections,
statements and locks have timeouts. Do not expose the database publicly.

An administrator manages invitations and access. Local operators can recover an
existing active administrator using the explicit vault database connection; see
the [operations guide](../../docs/operations.md#recover-an-existing-administrator).
Recovery atomically changes the password, revokes that administrator's sign-in
sessions and records an audit entry. It cannot enable accounts, promote members
or reopen bootstrap. Keep a second administrator and protect deployment
credentials. SSO, automated retention, background service installation and
managed-cloud provisioning remain outside this package.

## HTTP boundary

All bodies are JSON; errors use `{error, code?}`. Mutations require the same origin
when called from a browser. No CORS permission is granted. Credentials are opaque
random tokens stored only as hashes. Browser sessions expire after thirty days;
device tokens remain valid until revoked or their member is disabled.

| Routes | Credential | Contract |
|---|---|---|
| `GET /health`, `/ready`, `/api/status` | Public | Liveness, database readiness, initialization status |
| `POST /api/setup` | Bootstrap secret | One-time company/admin creation |
| `POST /api/auth/login`, `/api/auth/join` | Password / invitation | Session cookie and CLI session token |
| `POST /api/auth/logout`, `GET /api/me` | Member session | Sign out / current member |
| `GET, PUT /api/me/capture-rules` | Member session | Own account/location rules plus company repositories |
| `PUT /api/settings/policy` | Admin session | Company repository rules |
| `POST /api/invitations`, `GET /api/members`, `PATCH /api/members/:id` | Admin session | Invitation and access management |
| `GET /api/devices`, `DELETE /api/devices/:id` | Owner/admin session | Paginated devices and revocation |
| `GET /api/audit` | Admin session | Secret-free administrative audit |
| `POST /api/collector/enroll` | Member session | Source-specific device token |
| `GET /api/collector/policy` | Device | Current capture permissions/revision |
| `POST /api/traces/ingest` | Device | Capture-authorized trace batch; 202 acknowledgement, 409 stale revision |
| `GET /api/sessions`, `/api/sessions/:id/events` | Owner/admin session | Cursor-paginated retained traces |
| `GET /api/sessions/:id/export`, `DELETE /api/sessions/:id` | Owner/admin session | NDJSON export / durable deletion |

Pagination uses `limit` (1–100, default 50) and an opaque `cursor`; results contain
`items` and nullable `nextCursor`. Request schemas live in `src/http-contracts.ts`;
trace/policy schemas live in `iteration-trace-contracts`. Role and ownership gates
are enforced inside each database operation, not by hidden navigation links.
There is deliberately no coworker-search, bulk agent-download or archive-listing
credential: search authorization will be integrated with its dedicated design.

## License

See [LICENSE](LICENSE), [NOTICE](NOTICE) and the repository's
[source boundary](../../OPEN-SOURCE.md). The proprietary learning product is not
licensed by this package. Third-party dependencies retain their own licenses.
