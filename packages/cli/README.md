# Reusable trace collector

`iteration-trace-collector` is the Apache-2.0 collection library owned by Trace
Vault. The directory name `packages/cli` is historical; the package has **no
executable**, account provider, hosted endpoint, product commands, billing client,
friction-summary integration, launcher or updater. It requires Node.js 22.22.0
or later.

The supported API is the package root (`src/index.ts`), with native ESM,
Node 22 `require(ESM)` and TypeScript declarations. Deep source imports are not an
API. Consumers import the package rather than copying these modules:

```ts
import {
  acquireCollectorLock,
  collectorPaths,
  collectorSource,
  collectorSourceDirectory,
  collectorTick,
  initializeState,
  loadConfig,
  type CollectorConfig,
} from "iteration-trace-collector";

const paths = collectorPaths("/absolute/collector-data");
const config: CollectorConfig = await loadConfig(paths);
const release = await acquireCollectorLock(paths);
try {
  // On first connection, explicitly choose whether to include old sessions.
  await initializeState(collectorSource(config), collectorSourceDirectory(config), paths, true);
  await collectorTick(config, paths);
} finally {
  await release();
}
```

Keep the data directory on a local filesystem with working SQLite locks and hard
links, not a network share. The lock uses Node's built-in SQLite module (which
emits an experimental-feature warning on Node 22) without adding a dependency.
Its dedicated `collector.lock.sqlite` file is lock metadata, not trace storage;
never unlink it while any collector may be running. The OS releases ownership
when a process exits, including a crash. The retained `collector.lock.owner`
hard link identifies guard-aware markers, so PID reuse and container PID 1 do
not block recovery. PID-marker recovery is serialized. Release handles share
in-flight cleanup, retain ownership after cleanup failure for a safe retry, and
are idempotent after success.

Stop all older collector versions before upgrading or rolling back. The legacy
`collector.lock` PID marker remains readable by older versions, but their stale
recovery is not safe under concurrent mixed-version startup. An empty or invalid
legacy marker fails closed: stop every writer before removing only that marker
and restarting. Do not delete collector state or queued events to recover a lock.

## API responsibilities

- `collectorTick`, `scanSourceOnce`, `TraceUploadError`: bounded native scans,
  redaction, retryable durable outbox upload and acknowledgement. Accept an
  optional `CollectorFetcher` and cancellation signal at the transport boundary.
- Storage/config/state/health functions and types: version-compatible local data.
  `collectorPaths` requires an explicit directory; no product directory or
  enrollment endpoint is chosen for callers. Existing optional workspace
  metadata and file formats remain readable for deployed collectors/rollback.
- `sourceHome`, Claude/Codex/Cursor parsers, Git helpers, redaction and hook-queue
  readers: native collection without product enrollment or hook installation.
- `acquireCollectorLock`, `waitForCollectorLock`, `ensurePrivateDirectory` and
  Windows PowerShell helpers: shared single-writer and private-storage machinery.
- Vault policy authorization, enrollment, account evidence and metadata-only
  Claude receiver/setup functions: self-hosted native capture, independent of
  any Iteration account. Unsupported identity evidence fails closed.
- `createLogger`, `collectorLogger`, `configureCollectorLogging`: structured
  diagnostics. A host may configure additional context through a callback;
  the library reads no Iteration environment variables.

The API's runtime implementation is bundled into `dist/index.js`. Its type
declarations depend on the public `iteration-trace-contracts` and pinned `zod`
packages, declared as dependencies. Importing the API does not execute a CLI,
start a service, change a hook or perform authentication.

The [standalone package](../vault-collector/README.md) bundles `src/vault-cli.ts`
from this same source tree. It remains a dependency-free executable. The private
Iteration repository owns `iteration-cli`, including Clerk sign-in, workspace
enrollment, default endpoint, product commands, progress/friction/billing clients,
OS service installation and managed-runtime updating. It bundles this supported
library API into its own entries; none of that product code lives here.

## Verify the package boundary

From the repository root:

```sh
pnpm --filter iteration-trace-collector build
pnpm pack:collector-core
node scripts/pack.mjs trace-contracts
node scripts/smoke-cli.mjs
```

The smoke installs local tarballs offline in an isolated directory, exercises
the supported API against synthetic history, checks public declarations and
rejects product integration code in the bundled library. This check does not
publish a package. Public collector/core versions do not track Iteration CLI
versions or control its updater.
