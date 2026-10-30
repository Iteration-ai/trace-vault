# Trace Vault license and provenance

Trace Vault is licensed under the [Apache License, Version 2.0](LICENSE).
The following paths originate from the Apache-2.0 grant in Thytu/Iteration's
`OPEN-SOURCE.md`, including its working-tree modifications:

- `packages/vault/`
- `packages/cli/`
- `packages/trace-contracts/`
- `src/shared/ui/`
- `src/shared/contracts/`
- `src/app/globals.css`

Standalone build, packaging, documentation and workflow support is also
Apache-2.0. No proprietary Iteration application or Git history is included.
The grant conveys no rights to Iteration trademarks beyond the license.
Third-party components retain their respective licenses; collector bundles
include `THIRD-PARTY-NOTICES.txt` and preserved legal comments.

`packages/cli` owns the complete `iteration-cli`, including its Iteration
entrypoint, device authentication, history import, status rendering, launcher,
Cursor hook entrypoint and background-runtime supervision. Those modules are
part of the original explicit Apache-2.0 grant; no proprietary app code is needed.
`packages/vault-collector` contains only standalone packaging and builds directly
from the canonical CLI modules, not a copied implementation.

`iteration-trace-contracts` is the canonical shared contract package. Iteration's
publisher may publish it and `iteration-cli` from a pinned copy of this repository.
The public Trace Vault workflow publishes neither; the standalone collector
bundles the contracts and has no runtime npm dependencies.

`packages/trace-postgres` contains the shared trace persistence engine extracted
from Iteration's PostgreSQL integration: trace column/constraint declarations,
JSONB normalization, batch preparation, ingestion/deletion and raw-event/session
projection functions. Those extracted portions are also covered by Iteration's
Apache-2.0 grant. Authentication, authorization and learning/analysis extensions
remain in the private host; this extraction does not license or copy the rest of
the private adapter or historical migration files.
