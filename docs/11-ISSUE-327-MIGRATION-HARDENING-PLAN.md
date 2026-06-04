# Issue 327: DO SQLite Migration Hardening Plan

## Summary

Implement safe Durable Object SQLite upgrades by adding operational restart and schema diagnostics, making migrations atomic and idempotent, validating schema shape after migration, and surfacing diagnostics through `tila doctor`.

This plan preserves the existing local diagnostic route work and completes it rather than replacing it.

## Review Round 1: Architecture and Correctness

- Keep Cloudflare Worker runtime types inside Worker and backend Durable Object packages only.
- Keep `@tila/ops-sqlite` platform-neutral while allowing migrations to be either raw SQL or storage-adapter functions.
- Preserve all existing migration version numbers; hardening changes must not renumber shipped migrations.
- Gate project DO restart behind Worker `requirePermission("admin")`.
- Run migration body and `_migrations` version insert inside one DO SQLite `transactionSync()` call.
- Validate critical table columns after all pending migrations finish, and throw descriptive schema drift errors.

## Review Round 2: Tests and Operations

- Cover fresh migration, repeated cold-start reruns, partially applied recovery, duplicate-column recovery, and schema validation failure.
- Keep the stale-DO diagnostic fallback in the Worker route so old warm DOs still return actionable output.
- Ensure `tila doctor` reports schema diagnostics in both text and JSON output.
- Prefer targeted package tests before broader checks.

## Implementation

- Add `POST /projects/:projectId/admin/restart`, admin-only, forwarding to a DO route that calls `ctx.abort()`.
- Complete `GET /projects/:projectId/doctor/schema` with SQLite version, migrations, table list, and critical table column metadata.
- Add shared Zod schemas for the schema diagnostic response in `@tila/schemas`.
- Update the migration registry to support function migrations and guard all `ALTER TABLE ADD COLUMN` migrations with `PRAGMA table_info`.
- Add a reusable migration runner/validation helper and use it from `ProjectDO`.
- Extend `tila doctor` to call `/doctor/schema` and report migration/schema drift.

## Test Plan

- `pnpm --filter @tila/backend-do test -- --run migration-runner`
- `pnpm --filter @tila/backend-do test`
- `pnpm --filter @tila/worker test`
- `pnpm --filter tila-cli test`
- Targeted typecheck for touched packages.

## Assumptions

- Default plan save path is this file.
- Existing uncommitted changes in diagnostic routes are user work and must be preserved.
- `.github/workflows/` must not be modified.
