# Backend Interface Seam

The interfaces in this directory (`EntityBackend`, `CoordinationBackend`,
`ArtifactBackend`, `GateBackend`, `JournalBackend`, `SignalBackend`, `SchemaBackend`,
`SummaryBackend`) define the **CLI local/remote backend-swap contract**.

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

## The intentionally missing `RecordBackend`

There is no `RecordBackend` interface here. This is intentional: typed mutable records
(see `docs/08-RECORDS.md`) have no offline CLI path yet. Records are only accessible via
the remote Worker. When offline record access is added, a `RecordBackend` interface
should be added here alongside a corresponding `@tila/backend-local` implementation.
