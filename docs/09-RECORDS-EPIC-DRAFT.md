# GitHub Epic Draft: Typed Records

This file contains issue-ready drafts for implementing `record`, tila's typed
mutable JSON state primitive.

Source of truth: [`docs/08-RECORDS.md`](./08-RECORDS.md)

These drafts are intentionally scoped for autonomous coding agents. Each issue
points back to the original spec instead of restating every rule. If a detail in
this file conflicts with `docs/08-RECORDS.md`, the spec wins.

## Autonomous Agent Framing

### What Agents Need To Know

- `docs/08-RECORDS.md` is normative. Do not invent behavior from analogous
  systems when the spec is explicit.
- Implement records in phases. A partial implementation should leave the repo
  in a tested, useful state.
- Prefer existing package boundaries:
  - schemas and generic helpers in `@tila/schemas`
  - schema parsing/evolution in `@tila/core`
  - SQLite tables, migrations, and domain ops in `@tila/ops-sqlite`
  - Durable Object routing in `@tila/backend-do`
  - public HTTP routes in `@tila/worker`
  - CLI commands in `tila-cli`
  - public client helpers in `tila-sdk`
  - MCP tools/resources in `tila-mcp-server`
- Preserve platform boundaries. Do not import Cloudflare Worker types into
  `schemas`, `core`, `ops-sqlite`, `cli`, or `sdk`.
- Keep business logic out of Worker route handlers. Worker routes validate,
  handle R2 ordering when required, and forward to the DO.
- Use TDD locally within each issue. Start with the narrowest failing tests for
  that issue's behavior, then implement only enough to pass.
- Use workspace filters for verification, for example:
  - `pnpm --filter @tila/schemas test`
  - `pnpm --filter @tila/core test`
  - `pnpm --filter @tila/backend-do test`
  - `pnpm --filter @tila/worker typecheck`
  - `pnpm --filter tila-cli test`
- Do not modify `.github/workflows/`.
- `writers` is advisory in v0.1. Parse and preserve it, but do not reject
  writes based on it.

### What Helps

- Small vertical slices with explicit acceptance criteria.
- Tests that name spec concepts: `record created revision`, `stale record
  fence`, `record list metadata`, `mcp resource opt-in`.
- Existing entity/artifact/fence/journal code reused where behavior is shared.
- Shared helpers for canonical JSON, record resource names, validation, and
  top-level JSON filters.
- Clear distinction between current v0.1 work and deferred work.

### What Causes Drift

- Copying large chunks of the spec into issues and then editing them
  independently.
- Expanding record validation into JSON Schema enforcement.
- Adding nested query paths, FTS, hard delete, record relationships, JSON Patch,
  per-path fences, auto-merge, bidirectional git sync, or real cursor
  pagination.
- Treating records as work units or letting them appear in ready-set,
  hierarchy, blockers, claims, or gate logic except through resource/fence names.
- Refactoring internal entity names or the `entities` SQLite table while adding
  public work-unit aliases.
- Implementing snapshot artifacts before the core revision and fence semantics
  are stable.
- Letting CLI or MCP convenience behavior define the API contract.
- Enforcing `writers`, `spec/status`, or soft JSON resource references as core
  runtime semantics in v0.1.

## Creation Order

Create the epic first, then create child issues in this order. After child issue
numbers exist, edit the epic checklist to link each child issue.

1. Records schema primitives
2. Schema parser and evolution
3. DO SQLite schema
4. Core record ops
5. Patch, archive, list, and history
6. Worker API routes
7. Snapshot artifacts
8. CLI
9. SDK
10. MCP
11. Public work-unit aliases

## Epic Issue

### Title

Implement typed records from `docs/08-RECORDS.md`

### Labels

`epic`, `records`, `v0.1`

### Body

Implement `record`, tila's typed mutable JSON state primitive, as specified in
[`docs/08-RECORDS.md`](./08-RECORDS.md).

Records are shared project state addressed by `(type, key)` and exposed as
resource names of the form `record:<type>/<key>`. They are not work units, do
not participate in hierarchy/readiness/blockers/gates, and do not replace
artifacts. They are typed, schema-validated, fence-protected, revisioned JSON
objects with optional R2 snapshot artifacts.

#### Primary Goals

- Add schema support for `[records.<type>]`.
- Add canonical JSON storage and hashing.
- Add per-project DO SQLite tables for records, tags, and revisions.
- Add fenced create, set, patch, archive, unarchive, get, list, history, and
  types-in-use behavior.
- Add Worker routes under `/projects/:projectId/records`.
- Add CLI, SDK, and MCP surfaces.
- Add public work-unit aliases without renaming the internal `entities` table.

#### Source Of Truth

- Normative spec: [`docs/08-RECORDS.md`](./08-RECORDS.md)
- Architecture references:
  - [`docs/02-ARCHITECTURE.md`](./02-ARCHITECTURE.md)
  - [`docs/04-PERSISTENCE-SCHEMA.md`](./04-PERSISTENCE-SCHEMA.md)

#### Non-Goals For This Epic

- Secret storage or vault behavior.
- Secret detection, redaction, or per-record authorization enforcement.
- JSON Schema enforcement for `schema_ref`.
- Spec/status enforcement or controller reconciliation.
- TOML record input.
- Hard delete or purge.
- Record relationship tables.
- Full-text record search.
- Nested query language.
- JSON Patch RFC 6902.
- Path-set CLI sugar.
- Per-path fences or field-level conflict detection.
- Automatic three-way merge.
- Bidirectional repo sync.
- Full cursor pagination.
- Internal SQLite table rename from `entities` to work units.

#### Child Issues

- [ ] Records schema primitives
- [ ] Schema parser and evolution
- [ ] DO SQLite schema
- [ ] Core record ops
- [ ] Patch, archive, list, and history
- [ ] Worker API routes
- [ ] Snapshot artifacts
- [ ] CLI
- [ ] SDK
- [ ] MCP
- [ ] Public work-unit aliases

#### Definition Of Done

- All child issues are complete.
- `pnpm test`, `pnpm lint`, and `pnpm run typecheck` pass.
- Records do not appear in work-unit ready-set or hierarchy behavior.
- All public behavior follows `docs/08-RECORDS.md`.
- Deferred features remain deferred.
- `writers` remains advisory and does not reject writes.

#### Agent Drift Guards

- Do not broaden scope beyond the child issue being worked.
- Do not duplicate domain logic between Worker routes and `ops-sqlite`.
- Do not add package dependency cycles.
- Do not change CI workflow files.
- Do not make CLI behavior the source of truth for API behavior.

## Issue 1: Records Schema Primitives

### Title

Add record schema primitives and canonical JSON helpers

### Labels

`records`, `schemas`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: Identity And Scope
- `docs/08-RECORDS.md`: Type Validation
- `docs/08-RECORDS.md`: Key Validation
- `docs/08-RECORDS.md`: Tags
- `docs/08-RECORDS.md`: Canonical Storage
- `docs/08-RECORDS.md`: Size Limit
- `docs/08-RECORDS.md`: API Contract

### Body

Add the shared record primitives that later packages will use. This issue is
limited to schemas and pure helpers; it should not add database tables, Worker
routes, CLI commands, or MCP behavior.

#### Scope

- Add `RecordTypeSchema`.
- Add `RecordKeySchema`.
- Add `RecordTagSchema`.
- Add record resource helpers:
  - format `record:<type>/<key>`
  - parse by the first slash after `record:`
- Add canonical JSON serialization:
  - recursively sort object keys
  - preserve array order
  - emit no whitespace
- Add a SHA-256 helper for canonical JSON that is safe to use from all target
  packages.
- Add record value root validation for JSON objects.
- Add 64 KiB canonical JSON size validation, measured as UTF-8 byte length.
- Add request/response schemas for the record API shapes where appropriate in
  `packages/schemas/src/api.ts`.
- Export new public helpers from `packages/schemas/src/index.ts`.

#### Out Of Scope

- Parsing `[records.*]` from `tila.schema.toml`.
- Validating record fields against schema declarations.
- SQLite migrations or ops.
- Worker routes.
- CLI YAML parsing.
- Snapshot artifacts.

#### TDD Checklist

- Type validation accepts `pipeline_config`, `service`, `agent-policy`,
  `build_matrix`.
- Type validation rejects uppercase, leading digit, slash, colon, and dot.
- Key validation accepts `main`, `api/staging`, `package/auth`,
  `frontend/build`.
- Key validation rejects empty segments, trailing slash, `.` and `..`,
  leading `.` or `_` segments, colon, tilde, too many segments, and too-long
  segments.
- Tag validation lowercases and deduplicates case-insensitively.
- Tag validation rejects invalid characters and more than 20 tags.
- Resource parsing handles `record:pipeline_config/api/staging`.
- Canonical JSON recursively sorts object keys and preserves array order.
- Canonical JSON emits no whitespace and hashes/limits the UTF-8 encoded string.
- Canonical JSON value size rejects values over 64 KiB after canonicalization.
- Root record values reject arrays, scalars, and null.

#### Acceptance Criteria

- New tests pass in the affected package.
- `pnpm --filter @tila/schemas test` passes if that package has tests.
- `pnpm --filter @tila/schemas typecheck` or the repo's equivalent typecheck
  passes.
- No Cloudflare-specific types or APIs are imported into `@tila/schemas`.

#### Dependencies

- None.

#### Agent Drift Guards

- Do not invent additional key syntax.
- Do not add TOML, YAML, JSON Schema, JSON Patch, or nested query behavior.
- Do not make hashing depend on Worker-only or Node-only APIs inside
  `@tila/schemas`.

## Issue 2: Schema Parser And Evolution

### Title

Parse record definitions and classify record schema changes

### Labels

`records`, `core`, `schemas`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: Schema Format
- `docs/08-RECORDS.md`: Record Kind Fields
- `docs/08-RECORDS.md`: Writers
- `docs/08-RECORDS.md`: Validation
- `docs/08-RECORDS.md`: Schema Evolution

### Body

Extend `tila.schema.toml` support with `[records.<type>]` definitions and add
schema evolution classification for record changes.

#### Scope

- Add `RecordDefinitionSchema` to `packages/schemas/src/config.ts`.
- Add top-level `records` to `TilaSchemaTomlSchema`, defaulting to `{}`.
- Support record kind fields:
  - `format = "json" | "yaml"`, default `json`
  - `history = "revision" | "snapshot"`, default `revision`
  - optional `key_description`
  - optional advisory `writers`
  - optional `mcp_resource`, default `false`
  - optional reserved `schema_ref`
  - optional `[records.<type>.fields]`
- Extend field declarations for records to support `number`, `boolean`, and
  `json`.
- Keep work-unit field type validation unchanged unless shared code requires a
  split between work-unit field types and record field types.
- Parse and preserve `schema_ref` but do not enforce JSON Schema.
- Add semantic validation for record type names and allowed writer values.
- Preserve `writers` as advisory metadata only.
- Extend `diffSchemas` with record change classification.
- Add explicit change records that use `scope: "record"` and `typeName`, not
  `unitType`.
- Keep `diffSchemas` pure, matching the current entity/artifact pattern. If
  record removal counts are not available at this layer, emit `recordCount: 0`
  here and leave real count annotation to the caller that has database context.

#### Out Of Scope

- Runtime record value validation in DO ops.
- Database tables.
- Worker routes.
- CLI commands.
- JSON Schema enforcement.

#### TDD Checklist

- Parser accepts valid `[records.pipeline_config]` examples from the spec.
- Defaults are applied for `format`, `history`, `mcp_resource`, and omitted
  `writers`.
- Parser preserves `schema_ref` but does not enforce it.
- Parser accepts record field types `string`, `text`, `enum`, `list<string>`,
  `number`, `boolean`, and `json`.
- Parser rejects invalid record type names.
- Parser rejects invalid `format`, `history`, and `writers`.
- A declared record type with no fields parses successfully.
- `diffSchemas` classifies added record type as auto-applicable.
- `diffSchemas` emits `record-type-removed` with a `recordCount` field and
  treats it as destructive.
- `diffSchemas` classifies optional field additions as auto-applicable.
- `diffSchemas` classifies required field additions with `default_for_legacy`
  as auto-applicable.
- `diffSchemas` classifies required field additions without
  `default_for_legacy`, field removals, and field type changes as destructive.
- Changing `format`, `history`, `writers`, or `schema_ref` is auto-applicable
  in v0.1.

#### Acceptance Criteria

- Parser and schema-evolution tests cover record-specific paths.
- Work-unit schema tests still pass unchanged.
- No package dependency cycles are introduced.

#### Dependencies

- Issue 1.

#### Agent Drift Guards

- Do not enforce JSON Schema.
- Do not enforce `writers`; at most emit debug logging if an advisory mismatch
  is identifiable.
- Do not implement spec/status structure or reconciliation.
- Do not make `schema_ref` mutually exclusive with fields in v0.1 runtime.
- Do not add database access to `diffSchemas`.
- Do not change existing work-unit behavior unless tests prove a shared helper
  must be split.

## Issue 3: DO SQLite Schema

### Title

Add DO SQLite tables and migrations for records

### Labels

`records`, `ops-sqlite`, `backend-do`, `migration`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: Persistence Schema
- `docs/08-RECORDS.md`: Revision History
- `docs/08-RECORDS.md`: Tags

### Body

Add the per-project SQLite persistence schema for records, record tags, and
record revisions.

#### Scope

- Add Drizzle table definitions in `packages/ops-sqlite/src/schema.ts`:
  - `records`
  - `record_tags`
  - `record_revisions`
- Add migrations in `packages/ops-sqlite/src/migrations-sql.ts`.
- Add corresponding Durable Object migration SQL under
  `packages/backend-do/migrations/do/`.
- Use composite primary keys exactly as specified:
  - `records(type, key)`
  - `record_tags(type, key, tag)`
  - `record_revisions(type, key, revision)`
- Add indexes from the spec.
- Do not add `project_id` to per-project DO tables.
- Ensure migrations are idempotent and compatible with the existing migration
  runner.

#### Out Of Scope

- Record operation implementation.
- Runtime validation.
- Worker routes.
- CLI commands.
- R2 snapshot behavior.

#### TDD Checklist

- Migration creates all record tables.
- Migration creates required indexes.
- `record_revisions.operation` is constrained or validated to the allowed
  values: `created`, `set`, `patch`, `archived`, `unarchived`.
- Composite primary keys reject duplicates.
- Foreign keys from tags and revisions point to records.
- Migration runner applies the new version once.
- Existing migrations continue to apply cleanly on a fresh database.

#### Acceptance Criteria

- `pnpm --filter @tila/backend-do test -- --run migration` or closest matching
  migration tests pass.
- `pnpm --filter @tila/ops-sqlite typecheck` passes.
- Existing backend-do tests still pass.

#### Dependencies

- Issue 1 may be useful for shared type names, but this issue can mostly run in
  parallel with Issue 2.

#### Agent Drift Guards

- Do not add `project_id`.
- Do not store tags only inside `value_json`.
- Do not add pruning, TTL, hard delete, or cursor state columns.

## Issue 4: Core Record Ops

### Title

Implement create, set, and get record ops with fences and revisions

### Labels

`records`, `ops-sqlite`, `backend-do`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: Validation
- `docs/08-RECORDS.md`: Canonical Storage
- `docs/08-RECORDS.md`: Revision History
- `docs/08-RECORDS.md`: Fences And Mutation Semantics
- `docs/08-RECORDS.md`: Creation
- `docs/08-RECORDS.md`: Full Replace
- `docs/08-RECORDS.md`: Get Response
- `docs/08-RECORDS.md`: Error Contract

### Body

Implement the first usable record operations inside `@tila/ops-sqlite` and wire
them through the Durable Object router. This issue covers create, full replace,
and get only.

#### Scope

- Add `packages/ops-sqlite/src/record-ops.ts`.
- Implement `createRecord`.
- Implement `setRecord`.
- Implement `getRecord`.
- Validate declared record type against current schema.
- Validate record value root is a JSON object.
- Validate record fields using record declarations from current schema.
- Apply tolerant reads using each row's stored `schema_version`; validate writes
  against the current schema and update the row `schema_version` on mutation.
- Enforce canonical JSON storage and `value_sha256`.
- Enforce 64 KiB canonical JSON size as a hard DO backstop.
- Use `record:<type>/<key>` as the fence resource.
- `set` without a fence is create-only and returns initial fence `1`.
- `set` with a fence is update-only.
- Increment fence and revision in the same SQLite transaction.
- Insert a `record_revisions` row for every successful create and set.
- Append journal events inside the same transaction:
  - `record.created`
  - `record.updated`
- Return current tags in record responses, even if empty.
- Return the current fence as a top-level field for `get` and mutation
  responses.
- Add DO router endpoints needed for Worker forwarding, but do not add public
  Worker routes yet.

#### Out Of Scope

- Patch.
- Archive/unarchive.
- List/history queries.
- Snapshot artifact pointer rows.
- Public Worker API.
- CLI, SDK, MCP.

#### TDD Checklist

- Create without fence succeeds for declared type and returns fence `1`.
- Create stores canonical JSON and matching SHA-256.
- Create inserts revision `1` with operation `created` and the write-time
  schema version.
- Create appends `record.created` journal event.
- Duplicate create without fence returns/maps to `already-exists`.
- Set with valid fence replaces the entire value.
- Set with stale or missing fence returns/maps to `stale-fence`.
- Set of nonexistent record returns/maps to `not-found`.
- Set inserts operation `set`, increments revision, and appends
  `record.updated`.
- Writes to undeclared record type fail with `undeclared-type`.
- Missing required field and type mismatch fail with `constraint-violation`.
- Runtime field validation covers `string`, `text`, `enum`, `list<string>`,
  `number`, `boolean`, and opaque `json`.
- `json` fields accept any valid JSON value, including objects, arrays, strings,
  numbers, booleans, and null.
- Declared type with no fields accepts any JSON object.
- Values over 64 KiB fail with `payload-too-large`.
- Successful mutations update `records.schema_version` to the current schema
  version.
- Get returns archived records once archive exists later; for this issue, get
  returns active records and current fence.

#### Acceptance Criteria

- Focused backend-do/ops tests pass.
- Existing entity/fence/journal tests still pass.
- Record ops use a single SQLite transaction for correctness-critical writes.

#### Dependencies

- Issue 1.
- Issue 2.
- Issue 3.

#### Agent Drift Guards

- Do not implement merge patch in this issue.
- Do not add public HTTP routes yet.
- Do not store non-canonical JSON.
- Do not treat records as entities/work units.
- Do not enforce `writers` as authorization.

## Issue 5: Patch, Archive, List, And History

### Title

Add record patch, archive, list, history, tags, and types-in-use ops

### Labels

`records`, `ops-sqlite`, `backend-do`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: Merge Patch
- `docs/08-RECORDS.md`: Archive And Unarchive
- `docs/08-RECORDS.md`: Query Model
- `docs/08-RECORDS.md`: Tags
- `docs/08-RECORDS.md`: Data Filters
- `docs/08-RECORDS.md`: List Envelope
- `docs/08-RECORDS.md`: Metadata List Shape
- `docs/08-RECORDS.md`: History Response

### Body

Complete the core non-snapshot record operations in `@tila/ops-sqlite` and the
Durable Object router.

#### Scope

- Implement RFC 7396 JSON Merge Patch for record values.
- Implement `archiveRecord`.
- Implement `unarchiveRecord`.
- Implement `listRecords`.
- Implement `listRecordHistory`.
- Implement declared record type listing from the current schema.
- Implement `listRecordTypesInUse`.
- Implement tag storage and replacement semantics:
  - create: omitted tags mean empty tag set
  - set: omitted tags preserve existing tags
  - set: provided tags replace entire tag set
  - patch does not mutate tags
- Implement tag filtering.
- Implement top-level scalar `dataFilter` using the same comparison behavior as
  entity filters.
- Return list metadata by default, not full values.
- Return history newest-first, metadata-only by default, with optional values.
- When history is requested with values, use stored revision `schema_version`
  for tolerant-read behavior.
- Use limit cap behavior required by the spec:
  - hard cap `200` for list
  - query `LIMIT 201` internally
  - `meta.total`, `meta.limit`, and `meta.next_cursor` are always present
  - `next_cursor: null` or `"truncated"`
- For history, honor default `limit=20`.
- Add DO router endpoints for these operations.

#### Out Of Scope

- Snapshot artifact stamping.
- Public Worker routes.
- CLI commands.
- Full cursor pagination.
- Nested JSON filters.
- Explicit tag add/remove commands.

#### TDD Checklist

- Patch requires fence and rejects stale fence.
- Patch merges nested objects recursively.
- Patch replaces arrays whole.
- Patch `null` deletes a field.
- Patch validates the patched final value.
- Patch inserts operation `patch`, increments revision/fence, and appends
  `record.updated`.
- Archive requires fence, sets `archived = 1`, stores unchanged value, inserts
  operation `archived`, and emits `record.archived`.
- Archive already archived returns/maps to `invalid-state`.
- Unarchive mirrors archive behavior with operation `unarchived`.
- List requires type.
- List excludes archived by default.
- List can include archived records when explicitly requested.
- Get still returns archived records.
- Tag filtering returns matching active records.
- Data filter supports top-level scalar equality only.
- Object or array filter values are rejected.
- List returns metadata shape with tags and no full `value`.
- List envelope includes `items` and `meta.total`, `meta.limit`,
  `meta.next_cursor`.
- List returns `"truncated"` when more than 200 rows match.
- History is newest-first.
- History `values=false` omits values.
- History `values=true` includes values.
- History rows include operation, schema version, value SHA, artifact key
  fields, actor, timestamp, and message.
- Declared `types` returns schema-declared record types.
- Types-in-use returns distinct active types and excludes archived-only types.

#### Acceptance Criteria

- Focused backend-do/ops tests pass.
- Entity data filter behavior is not unintentionally changed.
- No deferred query features are added.

#### Dependencies

- Issue 4.

#### Agent Drift Guards

- Do not add nested path filtering.
- Do not add real cursor pagination.
- Do not add explicit tag add/remove commands unless a later issue requires
  them.
- Do not hard-delete records.

## Issue 6: Worker API Routes

### Title

Expose records through Worker API routes

### Labels

`records`, `worker`, `api`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: API Boundary
- `docs/08-RECORDS.md`: API Contract
- `docs/08-RECORDS.md`: Create Request
- `docs/08-RECORDS.md`: Set Request
- `docs/08-RECORDS.md`: Patch Request
- `docs/08-RECORDS.md`: Archive Request
- `docs/08-RECORDS.md`: Unarchive Request
- `docs/08-RECORDS.md`: Response Shape
- `docs/08-RECORDS.md`: Error Contract

### Body

Add public HTTP routes under `/projects/:projectId/records` and wire them to
the Durable Object record endpoints.

#### Scope

- Add `packages/worker/src/routes/records.ts`.
- Register records routes from `packages/worker/src/index.ts`.
- Implement routes:
  - `GET /projects/:id/records/_types`
  - `GET /projects/:id/records/:type`
  - `POST /projects/:id/records/:type`
  - `GET /projects/:id/records/:type/~/history/:key{.+}`
  - `POST /projects/:id/records/:type/~/archive/:key{.+}`
  - `POST /projects/:id/records/:type/~/unarchive/:key{.+}`
  - `GET /projects/:id/records/:type/:key{.+}`
  - `PUT /projects/:id/records/:type/:key{.+}`
  - `PATCH /projects/:id/records/:type/:key{.+}`
- Register `_types` and `~/...` routes before catch-all key routes.
- Validate type and key at the Worker/API boundary.
- Accept JSON only.
- Validate body object shape.
- Validate canonical record value size at the Worker/API boundary before
  forwarding to the DO.
- Validate list/history query parameters.
- Map backend errors to the spec's status codes and error codes.
- Include actor and token id when forwarding to the DO, following existing
  route patterns.

#### Out Of Scope

- Snapshot artifact R2 behavior.
- CLI, SDK, MCP.
- Work-unit aliases.

#### TDD Checklist

- Invalid type/key rejected at API boundary with `400 validation-error`.
- Non-object request body rejected with `400 validation-error`.
- Undeclared type maps to `422 undeclared-type`.
- Required field/type mismatch maps to `422 constraint-violation`.
- Missing record maps to `404 not-found`.
- Duplicate create maps to `409 already-exists`.
- Stale or missing fence maps to `409 stale-fence`.
- Invalid archive/unarchive state maps to `409 invalid-state`.
- Oversized value maps to `413 payload-too-large`.
- Create requires body `key` and validates it as a record key.
- `_types` route does not collide with type catch-all behavior.
- `~/history`, `~/archive`, and `~/unarchive` routes do not collide with
  slash-containing keys.
- List response uses pagination-ready envelope.
- List enforces the 200-row hard cap and returns `next_cursor: "truncated"`
  when more rows match.
- List returns metadata only.
- `_types` returns declared types by default and supports the in-use variant
  needed by `tila record types --in-use`.
- History supports `values=false` and `values=true`.

#### Acceptance Criteria

- Worker route tests pass.
- `pnpm --filter @tila/worker typecheck` passes.
- Business logic remains in backend packages, not route handlers.

#### Dependencies

- Issue 5.

#### Agent Drift Guards

- Do not accept YAML at the API boundary.
- Do not implement snapshot-specific R2 ordering here unless Issue 7 is also in
  scope.
- Do not add global record list across all types.
- Do not enforce `writers` as authorization.

## Issue 7: Snapshot Artifacts

### Title

Implement snapshot artifact flows for snapshot-history records

### Labels

`records`, `artifacts`, `worker`, `ops-sqlite`, `r2`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: Artifact Snapshots
- `docs/08-RECORDS.md`: History Modes
- `docs/08-RECORDS.md`: Snapshot Behavior
- `docs/08-RECORDS.md`: Snapshot Artifact Kinds
- `docs/08-RECORDS.md`: Write Ordering And Failure Modes
- `docs/08-RECORDS.md`: Set Request

### Body

Add snapshot artifact behavior for record types declared with
`history = "snapshot"`. This issue is intentionally after the core record ops
and Worker API so snapshot failure behavior can be tested against stable record
semantics.

#### Scope

- For full create/set on snapshot-history record types:
  - Worker canonicalizes final JSON value.
  - Worker writes canonical JSON artifact to R2 before DO mutation.
  - Clients do not supply `canonical_artifact_key`.
  - Worker forwards canonical artifact key to the DO.
  - DO transaction records artifact keys on `record_revisions`.
  - DO transaction upserts normal artifact pointer rows for snapshot artifacts.
- For CLI/source preupload support:
  - Accept optional `source_artifact_key` in create/set requests.
  - Validate provided source key is only allowed for snapshot-history types.
  - Validate source artifact pointer exists with system kind
    `record-snapshot-source` for resource `record:<type>/<key>`.
- For patch on snapshot-history record types:
  - DO performs primary mutation first and returns revision value.
  - Worker uploads canonical JSON for the returned revision.
  - Worker calls DO `stamp-artifacts` for that exact revision.
  - DO verifies revision still exists and stamps artifact keys.
  - DO upserts artifact pointer rows.
- Add system artifact kinds or metadata as required by existing artifact
  infrastructure.
- Preserve original source bytes only for full create/set file inputs. Patch
  files are not source snapshots.
- Preserve invariant: DO never references an R2 key that failed to write.

#### Out Of Scope

- CLI source file preupload implementation. This issue only supports the Worker
  and DO paths needed by the CLI.
- Record diff.
- Snapshot pruning.
- Requiring revision in R2 metadata.
- Cleanup/reconcile enhancements beyond existing orphan behavior.

#### TDD Checklist

- Full set for `history = "revision"` does not write snapshot artifacts.
- Full set for `history = "snapshot"` writes canonical artifact before DO call.
- DO failure after canonical R2 write leaves no DO reference to the failed
  mutation.
- Successful snapshot set stores `canonical_artifact_key` on the revision.
- Successful source snapshot set stores `source_artifact_key` when valid.
- Failed record mutation after source preupload may leave a tracked source
  artifact pointer without a revision reference; this is acceptable in v0.1.
- `source_artifact_key` is rejected for non-snapshot record types.
- `source_artifact_key` is rejected when pointer is missing or wrong kind.
- Patch snapshot records the revision before artifact stamping.
- Patch snapshot stamping updates only the intended revision.
- Patch snapshot R2 failure leaves the record revision without artifact keys.
- Stamp failure after R2 success leaves an orphan R2 blob but no dangling DO
  reference.
- System artifact pointer rows are created with resource `record:<type>/<key>`.

#### Acceptance Criteria

- Worker and backend-do tests cover both full set and patch snapshot flows.
- Failure tests prove the no-dangling-DO-reference invariant.
- Existing artifact lifecycle behavior remains compatible.

#### Dependencies

- Issue 6.

#### Agent Drift Guards

- Do not require a preliminary DO round trip to reserve a revision number.
- Do not accept client-supplied `canonical_artifact_key`.
- Do not store patch source files as `source_artifact_key`.
- Do not make snapshot behavior mandatory for all records.

## Issue 8: CLI

### Title

Add `tila record` CLI commands

### Labels

`records`, `cli`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: CLI Contract
- `docs/08-RECORDS.md`: CLI Input
- `docs/08-RECORDS.md`: set
- `docs/08-RECORDS.md`: patch
- `docs/08-RECORDS.md`: get
- `docs/08-RECORDS.md`: list
- `docs/08-RECORDS.md`: history
- `docs/08-RECORDS.md`: export
- `docs/08-RECORDS.md`: types

### Body

Add the public `tila record` command group and implement CLI behavior on top of
the JSON-only API.

#### Scope

- Add `packages/cli/src/commands/record.ts`.
- Register the command group in `packages/cli/src/commands/index.ts` or the
  existing command registry.
- Implement:
  - `tila record set <type> <key> <file> [--fence <n>] [--tag <tag>]... [--message <msg>] [--json]`
  - `tila record get <type> <key> [--format json|yaml] [--json]`
  - `tila record list <type> [--tag <tag>] [--filter <k=v>] [--include-archived] [--json]`
  - `tila record patch <type> <key> <file|--json <json>> --fence <n> [--message <msg>]`
  - `tila record archive <type> <key> --fence <n> [--message <msg>]`
  - `tila record unarchive <type> <key> --fence <n> [--message <msg>]`
  - `tila record history <type> <key> [--values] [--limit <n>] [--json]`
  - `tila record export <type> --output-dir <dir> [--format json|yaml]`
  - `tila record export --all --output-dir <dir> [--format json|yaml]`
  - `tila record types [--in-use] [--json]`
- Parse `.json`, `.yaml`, and `.yml` files at the CLI edge.
- Use strict JSON-compatible YAML parsing.
- Send JSON values to the API.
- For snapshot-history `set` file inputs, preupload raw source files through the
  artifact endpoint as kind `record-snapshot-source`.
- Preserve exact raw source bytes for full `set` file inputs so comments,
  formatting, and ordering survive in the source artifact.
- For non-snapshot types, skip source upload.
- Default `get` and `export` output format to the record type's schema-declared
  `format` unless `--format` overrides it.
- Implement output formatting consistent with existing CLI utilities.
- Resolve `--json` collision:
  - for most commands, `--json` controls output
  - for `record patch`, `--json <json>` is the inline patch payload
- Export slash-containing keys as nested paths.

#### Out Of Scope

- Path-set sugar.
- Record diff.
- Explicit tag add/remove commands.
- Bidirectional repo sync.
- Local backend parity unless the current CLI architecture requires it.

#### TDD Checklist

- `record set` sends create request when `--fence` is omitted.
- `record set` sends update request when `--fence` is present.
- JSON file input is parsed and sent as JSON.
- YAML file input is parsed and sent as JSON.
- YAML custom tags or non-JSON-compatible values are rejected.
- Snapshot set preuploads source file and sends `source_artifact_key`.
- Snapshot set preuploads exact raw source bytes before parsing.
- Non-snapshot set does not preupload source file.
- Patch inline JSON works.
- Patch YAML file works.
- YAML `~` in a patch becomes JSON null and deletes the field through merge
  patch semantics.
- Patch requires fence.
- Get outputs JSON.
- Get outputs YAML.
- Get defaults to the schema-declared format.
- List sends tag and string equality filter.
- List `--json` preserves API envelope.
- History sends `values` and `limit`.
- Export type writes one current-value file per record.
- Export excludes revision history.
- Export defaults to schema-declared format unless overridden.
- Export all composes list and get without requiring a new backend endpoint.
- Export keys with slash become safe nested paths.
- Types and `types --in-use` call the correct API endpoints.

#### Acceptance Criteria

- CLI command tests pass.
- `pnpm --filter tila-cli typecheck` passes.
- Commands follow existing CLI style and output helpers.

#### Dependencies

- Issue 6 for non-snapshot command behavior.
- Issue 7 for snapshot source preupload behavior.

#### Agent Drift Guards

- Do not add TOML support.
- Do not mirror records into `.tila/records`.
- Do not implement two-way git sync.
- Do not create new backend endpoints for export unless the spec changes.

## Issue 9: SDK

### Title

Add SDK record client helpers

### Labels

`records`, `sdk`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: API Contract
- `docs/08-RECORDS.md`: Get Response
- `docs/08-RECORDS.md`: Response Shape
- `docs/08-RECORDS.md`: History Response
- `docs/08-RECORDS.md`: Query Model

### Body

Expose typed records through the TypeScript SDK.

#### Scope

- Add `packages/sdk/src/records.ts`.
- Export `client.records.*` from the SDK entrypoint.
- Implement helpers for:
  - `types`
  - `typesInUse`
  - `create`
  - `set`
  - `get`
  - `patch`
  - `archive`
  - `unarchive`
  - `list`
  - `history`
- Use schema request/response types from `@tila/schemas` where available.
- Percent-encode slash-containing keys correctly in request paths.
- Keep list helpers metadata-only by default.

#### Out Of Scope

- CLI parsing.
- MCP tools.
- Snapshot source file preupload.
- Work-unit aliases.

#### TDD Checklist

- SDK builds the correct URLs for slash-containing keys.
- SDK create uses `POST /records/:type`.
- SDK set uses `PUT /records/:type/:key`.
- SDK patch uses `PATCH /records/:type/:key`.
- SDK archive/unarchive use `~/archive` and `~/unarchive`.
- SDK history supports `values` and `limit`.
- SDK list supports `tag`, `filter`, and `include_archived`.
- SDK list returns the API envelope.
- SDK `types` returns declared schema types.
- SDK `typesInUse` returns active persisted types only.

#### Acceptance Criteria

- SDK tests pass.
- `pnpm --filter tila-sdk typecheck` passes.
- Public exports are documented or discoverable in the same style as existing
  SDK modules.

#### Dependencies

- Issue 6.

#### Agent Drift Guards

- Do not parse YAML in the SDK.
- Do not hide fences from callers.
- Do not return full values from list helpers by default.

## Issue 10: MCP

### Title

Expose records through MCP tools and opt-in resources

### Labels

`records`, `mcp`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: MCP Contract
- `docs/08-RECORDS.md`: Tools
- `docs/08-RECORDS.md`: Resources

### Body

Add MCP record tools and opt-in record resources.

#### Scope

- Add MCP tools:
  - `tila_record_get`
  - `tila_record_set`
  - `tila_record_patch`
  - `tila_record_list`
  - `tila_record_archive`
  - `tila_record_unarchive`
  - `tila_record_history`
- Ensure `tila_record_list` returns metadata only.
- Add MCP resources only for record types with `mcp_resource = true`.
- Use URI template `tila://records/{type}/{key}`.
- Percent-encode keys when constructing resource URIs.
- Decode the final URI segment with `decodeURIComponent` before lookup.
- Default `mcp_resource` is false.

#### Out Of Scope

- Automatically injecting all records into context.
- Work-unit MCP aliases.
- CLI behavior.

#### TDD Checklist

- List tool returns metadata only.
- Get tool returns full value.
- Patch tool requires fence.
- Archive and unarchive tools exist and call correct endpoints.
- `mcp_resource = false` exposes no resources by default.
- `mcp_resource = true` exposes resource template/resource listing according to
  existing MCP server patterns.
- Slash-containing keys are percent-encoded in URIs and decoded on read.

#### Acceptance Criteria

- MCP server tests pass.
- `pnpm --filter tila-mcp-server typecheck` passes.
- Tool names match the spec exactly.

#### Dependencies

- Issue 6.
- Issue 9 may be useful if MCP uses the SDK internally, but do not force that
  dependency if existing MCP code calls the API directly.

#### Agent Drift Guards

- Do not expose every record as context by default.
- Do not return full values from list.
- Do not add extra MCP tools beyond the spec unless a later issue explicitly
  requests them.

## Issue 11: Public Work-Unit Aliases

### Title

Add public work-unit aliases while keeping entity compatibility

### Labels

`work-units`, `api`, `cli`, `sdk`, `mcp`, `compatibility`, `tdd`

### Spec References

- `docs/08-RECORDS.md`: Work-Unit Public Rename

### Body

Add the public `work unit` vocabulary while preserving existing entity/task
compatibility. This is a public aliasing issue, not an internal table rename.

#### Scope

- Add `/projects/:id/work-units` routes as aliases for existing entity routes.
- Keep `/projects/:id/entities` as deprecated aliases.
- Add `tila work-unit` generic CLI command.
- Keep `tila task` working as a task-specific convenience alias.
- Add `client.workUnits.*` in the SDK.
- Add generic `tila_work_unit_*` MCP tools.
- Keep existing `tila_task_*` MCP tools as aliases/deprecated task-specific
  tools, and keep any existing entity-named compatibility surfaces working
  according to current naming.
- Add deprecation notes where the existing project style supports them.

#### Out Of Scope

- Renaming `entity-ops.ts`.
- Renaming internal TypeScript `Entity` types.
- Renaming the SQLite `entities` table.
- Changing work-unit behavior.
- Coupling records to work-unit behavior.

#### TDD Checklist

- `/work-units` routes return the same behavior as `/entities`.
- Existing `/entities` route tests still pass.
- `tila work-unit` exposes generic entity/work-unit operations.
- `tila task` still works.
- `client.workUnits.*` calls the same endpoints/behavior as entity helpers.
- Generic MCP work-unit tools exist.
- Existing `tila_task_*` MCP tools remain compatible as aliases/deprecated
  task-specific tools.

#### Acceptance Criteria

- Existing entity/task tests still pass.
- New alias tests cover API, CLI, SDK, and MCP at the same depth as existing
  surfaces allow.
- No internal table or file renames are required.

#### Dependencies

- Can run independently of records, but should land after records API work if
  doing this epic sequentially to avoid increasing review noise.

#### Agent Drift Guards

- Do not rename the SQLite `entities` table.
- Do not refactor entity internals unless required for a thin public alias.
- Do not change readiness, blockers, claims, gates, or hierarchy semantics.

## Completeness Review Pass 1

Epic-level checks:

- [x] The epic names `docs/08-RECORDS.md` as the normative source.
- [x] The epic separates goals from non-goals.
- [x] Every major implementation phase from the spec has a child issue.
- [x] Deferred work is explicitly excluded.
- [x] Package boundaries are stated.
- [x] Final verification includes tests, lint, and typecheck.

Issue-level checks:

- [x] Every issue has spec references.
- [x] Every issue has scope and out-of-scope sections.
- [x] Every issue has TDD-first behavior checks.
- [x] Every issue has acceptance criteria.
- [x] Every issue names dependencies.
- [x] Every issue has drift guards.

## Completeness Review Pass 2

Autonomous-agent checks:

- [x] An agent can tell where to start.
- [x] An agent can tell what not to implement.
- [x] An agent can run focused tests without guessing package names.
- [x] An agent can stop after one issue and leave a coherent partial result.
- [x] An agent is warned away from deferred features.
- [x] An agent is warned away from broad refactors.

Cross-issue consistency checks:

- [x] Snapshot artifacts are isolated after core API semantics.
- [x] CLI source preupload depends on snapshot Worker/DO support.
- [x] SDK and MCP depend on stable API behavior.
- [x] Work-unit aliases do not block records.
- [x] API remains JSON-only while CLI handles YAML.
- [x] Records remain separate from work-unit readiness/hierarchy behavior.

## Spec Review Pass 1: Coverage

- [x] Decision summary covered by epic goals and child issues.
- [x] Identity, type, key, resource parsing, and tag validation covered.
- [x] Schema format, defaults, writers, `mcp_resource`, and `schema_ref`
  covered.
- [x] Root object validation, record field validation, canonical JSON, SHA-256,
  and 64 KiB UTF-8 size limit covered.
- [x] Persistence tables, indexes, revision operation values, and no
  `project_id` covered.
- [x] Fence semantics for create, set, patch, archive, and unarchive covered.
- [x] Query model, metadata list shape, envelopes, declared types, and in-use
  types covered.
- [x] API routes, reserved `_types` and `~` segments, JSON-only boundary, and
  error mappings covered.
- [x] CLI JSON/YAML input, YAML output, export, and snapshot source preupload
  covered.
- [x] SDK, MCP tools/resources, and public work-unit aliases covered.
- [x] Security/secrets, repo sync, spec/status, JSON Schema, and other deferred
  work are explicitly excluded.

## Spec Review Pass 2: Contradictions And Drift

- [x] Removed optional wording around canonical JSON SHA-256 helper so it
  matches the spec's Phase 1 expectation.
- [x] Clarified that `writers` is parsed and preserved but never enforced in
  v0.1.
- [x] Clarified that API remains JSON-only while CLI owns YAML parsing.
- [x] Clarified that snapshot canonical artifact keys are Worker-generated, not
  client-supplied.
- [x] Clarified that patch files are not stored as source snapshots.
- [x] Clarified that `diffSchemas` stays pure and does not acquire database
  access.
- [x] Clarified that public work-unit aliases do not rename internal entity
  tables or types.
