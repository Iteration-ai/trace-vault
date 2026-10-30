# PostgreSQL trace engine

Hosts supply authentication, authorization, capture-policy checks, project
validation and an open Drizzle PostgreSQL transaction. The engine opens no pool
or transaction. A rejected engine operation or extension must reject the host
transaction; do not catch it and commit partial work.

## Schema

`traceEventColumns()`, `traceSessionColumns()` and
`traceSessionDeletionColumns()` return fresh Drizzle column builders.
`traceEventConstraints(table)`, `traceSessionConstraints(table)` and
`traceSessionDeletionConstraints(table)` return canonical keys, checks and
indexes. Hosts append their own foreign keys. `bindTraceTables(schema,
{concurrently: false})` binds the three tables without host foreign keys and
disables concurrent index creation for transactional host migrations. The default
preserves private concurrent indexes. Schema names are explicit lowercase
PostgreSQL identifiers, never inferred from `search_path`, including `public`.

After creating/migrating those tables, call
`installTraceProjections(dedicatedPgClient, "vault")` from
`iteration-trace-postgres/migrate`, outside a transaction. It atomically installs
versioned SQL and records checksums in `vault.__trace_engine_migrations`.
The installer requires an existing `vault.collector_devices` table or view with
`organization_id uuid`, `user_id uuid`, `id uuid`, and `source text`; assignments
are stable and unique by tenant/stream. Projection functions use explicitly
qualified host relations/functions and a fixed `pg_catalog` search path.
Host migrations must precede this installer; semantic projection changes need
a new canonical SQL version and an explicit host data backfill.

## Ingestion

`ingestTraceBatch(tx, schema, context, {events}, extension?, receivedAtByEventId?)` accepts
`context = {organizationId, userId, deviceId, source}` from host authorization.
The UUID `deviceId` identifies a storage stream, not necessarily the credential
used for this upload. Native hosts can bind re-enrolled credentials to the same
stream. The batch must already satisfy the shared wire contract, and non-null
project UUIDs must be authorized by the host.

`prepareTraceIngestRows(batch)` returns `{events, rows, sessionIds,
acceptedEventIds}`. `events` contains the original deduplicated winning events,
including original capture/project provenance; `rows` contains storage-normalized
payloads. Native receipt creation should use these winners rather than implement
its own preference algorithm. The optional sixth argument is a map from event ID
to original UTC ISO timestamp, preserving microsecond `ingested_at` values during
a stopped-writer upgrade. It affects inserts only; normal uploads omit the map.

It returns `{acceptedEventIds, changedEvents, metadataSessionIds}` and awaits
`extension(tx, changes)` inside the same transaction, after projection repairs.
Each changed row has `{organizationId, deviceId, eventId, sessionId, sequence,
eventType, inserted, ingestedAt}`. `inserted` distinguishes new records from
monotone streaming-usage replacements. `ingestedAt` is UTC with microsecond
precision and remains the original receipt time on updates. No raw payload is
duplicated in this metadata. Replays and tombstoned rows are acknowledged but
absent from `changedEvents`; metadata session IDs come only from changed rows.
Public hosts can create receipt/session UUID metadata from inserted rows and
update receipt provenance for usage replacements in the extension.

Canonical session columns `sourceTitle`, `sourceCwd`, and `sourceRepositoryUrl`
are the last nonblank session metadata values in `(sequence, event_id COLLATE C)`
order. Cwd and repository values preserve meaningful internal whitespace.
`firstUserMessagePreview` is the first nonblank message in that ordering, with
Unicode whitespace collapsed and a 160-Unicode-character limit. Its shared SQL
extractor tries text, message, then text/input_text content blocks, falling through
Unicode-only blanks. These fields do not require run markers; private
`userMessagePreview` and own-run launch/lineage projections retain their existing
semantics. Adopting populated tables requires a batched host backfill calling
`schema.trace_session_presentation(organization_id, device_id, session_id)`;
do not parse raw payloads again in the host.

## Deletion

`deleteTraceSession(tx, schema, context, sessionId, beforeDelete?, options?)` returns
`{status: "deleted" | "already_deleted" | "not_found"}`. It checks the selected
stream/session exists or an earlier tombstone exists, then tombstones and deletes
that tenant/contributor/session across storage streams. It awaits
`beforeDelete(tx)` after the session lock/tombstone and before deleting events,
allowing a host to retain event-ID tombstones or audit metadata. Unknown sessions
do not invoke the callback by default. The sixth argument
`{tombstoneMissing: true}` tombstones never-captured sessions, invokes the callback,
and returns `deleted`; later calls return `already_deleted`. Private hosts omit it
and retain `not_found`.

Session locks and tombstones are tenant/contributor/session scoped. A public
native host can use distinct source-specific tenant UUIDs to retain source-local
deletion while private multi-workspace hosts retain all-source semantics. Source
identity must never be changed for an existing stream.
