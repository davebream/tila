# Backend Interface Seam

The interfaces in this directory (`EntityBackend`, `CoordinationBackend`,
`ArtifactBackend`, `GateBackend`, `JournalBackend`, `SignalBackend`, `SchemaBackend`,
`SummaryBackend`, `RecordBackend`) define the **CLI local/remote backend-swap contract**.

## What this seam is

The CLI (`tila-cli`) supports two execution modes:

- **Remote mode** — forwards calls to the live Cloudflare Worker over HTTP.
- **Local mode** — runs against `@tila/backend-local` (a `bun:sqlite`-backed SQLite
  database on the developer's machine), without a network connection.

These interfaces are the boundary that makes the swap transparent. The CLI resolves a
concrete backend implementation at startup and then calls the same interface methods
regardless of which mode is active.

## What this seam is NOT

These interfaces are **not** the Durable Object contract. The `ProjectDO`
(`@tila/backend-do`) does **not** implement these interfaces; it calls `@tila/ops-sqlite`
modules directly via Drizzle. The interface seam is purely for the CLI backend-swap path.

## `RecordBackend`

`RecordBackend` (`record-backend.ts`) is the seam for typed mutable records
(see `docs/08-RECORDS.md`). It is typed against the canonical record types in
`@tila/schemas` (`RecordRow`, `RecordListItem`, `RecordHistoryItem`) — the same
single source of truth consumed by `@tila/ops-sqlite`. Input plumbing the backend
resolves itself (`schema_version`, `actor`, `origin`, `canonical_artifact_key`) is
omitted from the input shapes; the return types preserve those as read-only output
fields. A concrete `@tila/backend-local` implementation will follow in a subsequent
task to provide the offline CLI record path.
