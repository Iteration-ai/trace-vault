# Trace Vault license and provenance

Trace Vault is licensed under the [Apache License, Version 2.0](LICENSE).
The following paths originate from the Apache-2.0 grant in Thytu/Iteration's
`OPEN-SOURCE.md`, including its working-tree modifications:

- `packages/vault/`
- `packages/cli/`
- `packages/trace-contracts/`
- `src/shared/ui/`
- `src/app/globals.css`

Standalone build, packaging, documentation and workflow support is also
Apache-2.0. This grant does not cover the rest of Iteration's private application
or its Git history. Removing consumer-specific code from the current tree does
not revoke Apache-2.0 grants for previously distributed code.
The grant conveys no rights to Iteration trademarks beyond the license.
Third-party components retain their respective licenses; collector bundles
include `THIRD-PARTY-NOTICES.txt` and preserved legal comments.

`packages/cli` owns reusable collection machinery and the standalone Vault
entrypoint. Consumer-specific authentication, enrollment, commands and analysis
integrations do not belong in this repository. `packages/vault-collector`
contains standalone packaging and builds directly from that collection source,
not a copied implementation.

`iteration-trace-contracts` contains trace formats and capture-policy contracts,
not a consumer's login, billing or learning APIs. The standalone collector bundles
the contracts and has no runtime npm dependencies.

`packages/trace-postgres` contains the shared trace persistence engine extracted
from Iteration's PostgreSQL integration: trace column/constraint declarations,
JSONB normalization, batch preparation, ingestion/deletion and raw-event/session
projection functions. Those extracted portions are also covered by Iteration's
Apache-2.0 grant. Authentication, authorization and learning/analysis extensions
remain in the private host; this extraction does not license or copy the rest of
the private adapter or historical migration files.
