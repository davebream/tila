# Typed Records

## Status

Implemented.

This document captures the v0.1 design for `record`, tila's typed mutable
JSON state primitive. It is written as an implementation guide for coding
agents and maintainers who do not have access to the design discussion that
produced it.

## Problem

tila currently has a clear concept for units of work and immutable artifacts:

- **Work units**: task/issue/epic-like items that participate in hierarchy,
  readiness, claims, blockers, gates, and artifact production.
- **Artifacts**: immutable content-addressed files/blobs with lifecycle,
  search, references, and R2-backed storage.
- **Journal events**: append-only audit events for durable state transitions.

The code still exposes the work-unit concept as `entities` in many places, but
the architecture document already defines these as "work units" and stores
them in the `entities` table.

Teams using tila also need a third data shape:

- pipeline configs
- service catalogs
- agent policies
- build matrices
- deploy target maps
- repo/package metadata
- framework-specific coordination manifests

These are not work units. They are not tasks, should not appear in ready-set
queries, and do not participate in parent-child hierarchy. They are also not
plain artifacts because agents need stable names, current values, validation,
concurrent update protection, revision history, and structured queries.

The answer is a new public concept: **typed records**.

## Decision Summary

```text
Public name:       record
Identity:          (type, key), unique within one tila project
Resource name:     record:<type>/<key>
Storage:           DO SQLite per project
Value:             canonical JSON in value_json TEXT NOT NULL
Value limit:       64 KiB canonical JSON
Input formats:     API JSON only; CLI JSON + YAML
TOML:              not supported in v0.1
History:           mandatory SQLite revisions
Snapshots:         opt-in R2 artifacts with history = "snapshot"
Deletion:          archive/tombstone only
Relationships:     none in v0.1; use soft resource refs in JSON
Permissions:       no per-record enforcement in v0.1; writers is advisory
MCP:               tools by default; resources opt-in per record type
```

## Terminology

### Work Unit

A work unit is something agents do work on: a task, issue, epic, migration,
investigation, or another project-defined work item. Work units participate in
claims, readiness, blockers, gates, hierarchy, and artifact production.

The public concept should be renamed from `entity` to `work unit`. The internal
SQLite table can remain `entities` until a separate cleanup.

### Artifact

An artifact is immutable content-addressed data stored in R2, with a pointer row
in DO SQLite. Artifacts are good for exact files, generated outputs, source
materials, snapshots, patches, transcripts, and searchable text.

### Record

A record is typed mutable project state:

```text
(type, key) -> JSON object
```

Records are shared state that agents and humans read or update under fences.
They have schema validation, revision history, tags, and stable names.

### Resource

A resource is an internal addressable target for fences, claims, gates, and
journal entries. Record resource names use:

```text
record:<type>/<key>
```

## Non-Goals

v0.1 records do not provide:

- a secret store or vault
- a filesystem mirror
- bidirectional sync with git
- hard deletes
- record relationship tables
- JSON Schema validation
- TOML parsing
- spec/status enforcement
- controller reconciliation
- full pagination cursors
- full-text search
- nested query language
- JSON Patch
- path-set CLI sugar
- per-path fences or field-level conflict detection
- automatic three-way merge

## Design Rationale

### Why Not "Manifest"?

"Manifest" is too narrow. It describes a common config-file-shaped use case,
but teams need more than manifests: service catalogs, agent policies, build
matrices, environment maps, package metadata, and framework-specific state.

### Why Not "Register"?

"Register" sounds like a singleton named pointer or current-value register. The
general need is multiple user-defined record types, each with many keys.

### Why Not "KV"?

Records are not low-level key-value storage. They are typed, schema-validated,
fence-protected, revisioned JSON objects.

### Why Not Reuse Work Units?

Work units have work semantics: hierarchy, readiness, blockers, gates, claims,
status, and task lifecycle. A pipeline config or service catalog entry is not a
work item. Forcing records into work units would pollute ready-set and hierarchy
logic and make the model harder for agents to reason about.

### Research Signals

The design follows several 2026 infrastructure and agent-tooling patterns:

- Kubernetes custom resources show the value of user-defined typed resources,
  but also show the danger of making namespace/scope part of identity before
  the product has real scope semantics.
- MCP separates resources (context offered to the model) from tools (actions).
  Records should be MCP tools by default and MCP resources only when explicitly
  opted in.
- LangGraph-style stores use JSON documents addressed by namespace/key. That
  maps to typed records more closely than to file manifests.
- Agent coding tools rely heavily on repo config files, but those files are
  mostly static authoring context. tila records are live coordinated state.

## Identity And Scope

### Locked Decision

```text
Record identity:   (type, key)
Scope:             implicit project scope from the Durable Object
Resource name:     record:<type>/<key>
Partitioning:      tags only in v0.1
Duplicate keys:    no duplicate (type, key) within a project
```

Do not add `project_id` to per-project DO tables. The DO is already the project
boundary. Add `project_id` only to global D1 indexes, SDK envelopes, exports, or
cross-project features.

### Why Scope Is Not In The Primary Key

Do not use `(type, scope, key)` in v0.1.

Reasons:

- The DO boundary already provides project isolation.
- Multi-repo auth is not enforced yet.
- Scope taxonomy will likely evolve. Putting it in identity would make future
  changes destructive for fences, journal events, and references.
- Tags are additive; primary key changes are not.

Future multi-repo support may enforce authorization and filtering from
`repo:*` tags, but tags do not become identity.

> For multi-namespace coexistence within one project (frameworks on the SDK sharing a project with direct use), see [Shared-Project Coexistence](09-SHARED-PROJECT-COEXISTENCE.md).

### Type Validation

Record types are declared in `tila.schema.toml` under `[records.<type>]`.

```text
Regex: ^[a-z][a-z0-9_-]*$
```

Rules:

- lowercase only
- starts with a letter
- no slash
- no colon
- no dot

Examples:

```text
pipeline_config
service
agent-policy
build_matrix
```

### Key Validation

```text
Segment regex: ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$
Segment max:   64 characters
Max segments:  8
Whole max:     256 characters
```

Rules:

- keys are slash-delimited path-like identifiers
- each segment starts with an alphanumeric character
- segments may contain letters, numbers, `_`, `.`, and `-`
- slashes separate hierarchy-like segments
- no colon
- no tilde (`~`), reserved for API action routes
- no empty segments
- no trailing slash
- no `.` or `..` segments
- no segments starting with `.` or `_`

Examples:

```text
main
api
api/staging
package/auth
frontend/build
```

### Resource Parsing

`record:<type>/<key>` parses by the first slash after `record:`.

```text
record:pipeline_config/main        -> type=pipeline_config, key=main
record:pipeline_config/api/staging -> type=pipeline_config, key=api/staging
record:service/frontend            -> type=service, key=frontend
```

The `~` segment is reserved for API action routes and is not valid in keys.

## Schema Format

Add a top-level `[records]` section to `tila.schema.toml`.

Example:

```toml
[records.pipeline_config]
format = "yaml"
history = "snapshot"
key_description = "config variant name"
writers = ["human"]
mcp_resource = true

[records.pipeline_config.fields]
name = { type = "string", required = true }
version = { type = "string", required = true }
environments = { type = "json" }

[records.service]
format = "json"
history = "revision"
key_description = "service name"
writers = ["human", "agent"]

[records.service.fields]
name = { type = "string", required = true }
owner = { type = "string", required = true }
replicas = { type = "number" }
enabled = { type = "boolean" }
config = { type = "json" }

# Future JSON Schema validation.
# In v0.1 schema_ref is accepted and preserved, but not enforced.
# When enforcement ships, schema_ref and [records.<type>.fields] are mutually
# exclusive.
[records.deploy_target]
format = "yaml"
history = "revision"
schema_ref = "$schemas/deploy-target.json" # reserved, not enforced in v0.1
```

### Record Kind Fields

```text
format:          "json" | "yaml"
history:         "revision" | "snapshot"
key_description: optional human-facing description
writers:         optional advisory list, not enforced in v0.1
mcp_resource:    optional boolean, default false
schema_ref:      reserved for future JSON Schema support
fields:          FieldDeclaration-style record field declarations
```

Defaults:

```text
format = "json"
history = "revision"
mcp_resource = false
writers omitted = unrestricted/advisory none
```

### Writers

`writers` is parsed and preserved but not enforced in v0.1.

Allowed values:

```toml
writers = ["human"]
writers = ["agent"]
writers = ["human", "agent"]
```

When real identity lands, such as GitHub-scoped auth, these declarations can be
enforced without schema migration.

If the runtime can identify an advisory mismatch in v0.1, it may emit a
debug-level log, but it must not reject the write.

### Spec/Status Convention

Records have one `value_json` column. There is no core `spec`/`status` split in
v0.1.

Teams anticipating controller-style reconciliation may use top-level `spec` and
`status` keys as a convention:

```json
{
  "spec": {
    "desiredVersion": "1.2.3"
  },
  "status": {
    "observedVersion": "1.2.2",
    "lastCheckedAt": 1779090000000
  }
}
```

Future schema may add:

```toml
structure = "spec-status"
```

or:

```toml
mode = "reconciled"
```

Do not implement that in v0.1.

## Validation

### v0.1 Validation Model

Use the existing `FieldDeclarationSchema` style and extend it for records.

Existing field types:

```text
string
text
enum
list<string>
```

New field types for records:

```text
number
boolean
json
```

`json` accepts any valid JSON value, including objects, arrays, strings,
numbers, booleans, and null. It is opaque: no nested structural validation in
v0.1.

The record type itself must be declared in `tila.schema.toml`. Writes to an
undeclared record type are rejected with `422 undeclared-type`.

If a declared record type has no `[records.<type>.fields]` section, it accepts
any valid JSON object. This is the v0.1 escape hatch for teams that need a
registered type but do not yet want field-level validation.

### Root Value Shape

Record `value_json` should be a JSON object in v0.1.

This keeps field declarations and merge-patch semantics sane. Nested values may
be any JSON value through fields of type `json`.

Valid:

```json
{
  "name": "api",
  "enabled": true,
  "config": {
    "ports": [8080],
    "timeout": null
  }
}
```

Not valid as a whole record root in v0.1:

```json
"hello"
```

```json
[1, 2, 3]
```

### Size Limit

Record values are limited to 64 KiB, measured as the UTF-8 byte length of the
canonical JSON string.

Validate this limit at the Worker/API boundary before forwarding to the DO, and
validate it again in DO operations as a hard backstop. Larger payloads belong in
artifacts, with records storing structured pointers or metadata.

### JSON Schema Reservation

`schema_ref` is reserved but ignored by runtime validation in v0.1.

When JSON Schema support ships:

```text
fields XOR schema_ref
```

A record type must have exactly one validation path. Do not validate one record
type with both FieldDeclaration fields and JSON Schema.

## Formats

### API Boundary

The Worker/API accepts JSON only.

This keeps the Worker bundle smaller and gives one validation path and one
error surface.

### CLI Input

The CLI accepts:

```text
.json
.yaml
.yml
```

Format is detected by extension. YAML is parsed at the CLI edge into canonical
JSON, then JSON is sent to the API.

YAML parsing should use a JSON-compatible strict schema. Reject custom tags and
avoid YAML's broad implicit typing surprises.

### Canonical Storage

Store canonical JSON only:

```sql
value_json TEXT NOT NULL
```

Canonical JSON means:

```text
JSON.stringify(value, sortedKeysRecursive, 0)
```

Rules:

- sort object keys recursively
- preserve array order
- emit no whitespace
- encode/hash as UTF-8

Define the canonical serializer in `@tila/schemas` and use that single function
for Worker validation, DO storage, hashing, SDK helpers, and CLI YAML
normalization. `value_sha256` is the SHA-256 of this canonical string.

### TOML Exclusion

Do not support TOML for records in v0.1.

TOML cannot represent full JSON semantics:

| JSON value | YAML | TOML |
|---|---|---|
| `null` | `null` / `~` | cannot represent |
| `[1, "two", true]` | valid | forbidden |
| deeply nested objects | valid | possible but verbose |

Records intentionally support arbitrary JSON-shaped state where `null` can be a
real value. TOML would introduce lossy or failing round-trips.

## Persistence Schema

Add per-project DO SQLite tables.

```sql
CREATE TABLE IF NOT EXISTS records (
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  value_sha256 TEXT NOT NULL,
  revision INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (type, key)
);

CREATE INDEX IF NOT EXISTS idx_records_type
  ON records(type);

CREATE INDEX IF NOT EXISTS idx_records_archived
  ON records(type, archived);

CREATE TABLE IF NOT EXISTS record_tags (
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (type, key, tag),
  FOREIGN KEY (type, key) REFERENCES records(type, key)
);

CREATE INDEX IF NOT EXISTS idx_record_tags_tag
  ON record_tags(tag);

CREATE TABLE IF NOT EXISTS record_revisions (
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  value_sha256 TEXT NOT NULL,
  canonical_artifact_key TEXT,
  source_artifact_key TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message TEXT,
  PRIMARY KEY (type, key, revision),
  FOREIGN KEY (type, key) REFERENCES records(type, key)
);

CREATE INDEX IF NOT EXISTS idx_record_revisions_record
  ON record_revisions(type, key, revision);
```

Do not add `project_id` to these tables.

`record_revisions.operation` must be one of:

```text
created
set
patch
archived
unarchived
```

`record_revisions.schema_version` is the schema version used for validation at
write time. History reads with `values=true` need this to apply tolerant-read
rules correctly.

## Revision History

Revision history is mandatory for every record mutation.

Rules:

```text
Every successful create, set, patch, archive, and unarchive:
  increments revision
  writes record_revisions
  appends a journal event
```

v0.1 stores the full `value_json` per revision. No pruning.

Future options:

```toml
max_revisions = 100
retention_days = 365
```

Do not implement revision pruning in v0.1.

## Artifact Snapshots

### History Modes

```text
history = "revision"  -> SQLite revision row only
history = "snapshot"  -> SQLite revision row + R2 artifact snapshots
```

`history = "revision"` is the default.

### Snapshot Behavior

For `history = "snapshot"`:

- write a canonical JSON artifact for every mutation
- write the original submitted source file only for full `set` operations where
  the CLI submitted a complete file
- store artifact keys on the `record_revisions` row
- create normal artifact pointer rows for tracked snapshot artifacts

Use two nullable columns:

```text
canonical_artifact_key
source_artifact_key
```

The canonical artifact is always canonical JSON. The source artifact preserves
comments, formatting, ordering, and exact bytes when available.

Patch files are not stored as `source_artifact_key`. A patch file is a partial
update, not the source form of the full record. Patch auditability comes from
`record_revisions.operation = "patch"`, the revision value, and the journal
event.

### Snapshot Artifact Kinds

Use distinct artifact kinds or metadata so cleanup/reconcile can identify these
objects.

Suggested kinds:

```text
record-snapshot-canonical
record-snapshot-source
```

These are system artifact kinds. They do not require user declarations under
`[artifacts.*]`.

Record snapshots must create normal artifact pointer rows using the existing
artifact pointer/upsert path, with resource `record:<type>/<key>`. This keeps
orphan detection, cleanup, and artifact lifecycle behavior consistent with
ordinary artifacts.

Suggested metadata:

```text
tila-record-type
tila-record-key
tila-sha256
tila-kind
tila-mime
```

Do not require `tila-record-revision` in R2 metadata in v0.1. Revision is
assigned in the DO transaction. Avoid a preliminary DO round trip just to
reserve a revision number.

## Write Ordering And Failure Modes

For `history = "revision"`:

```text
DO transaction:
  validate schema
  validate fence
  update records
  insert record_revisions
  append journal
```

Fully atomic within DO SQLite.

For full `set` with `history = "snapshot"`:

```text
1. CLI optionally uploads the original source file as a system artifact
2. Worker canonicalizes the final value and uploads canonical JSON to R2
3. Worker forwards value and artifact keys to DO
4. DO transaction:
   validate schema
   validate fence or create-only precondition
   update records
   insert record_revisions with artifact keys
   upsert artifact pointer rows
   append journal
```

The Worker already has the final value for full `set`, so the canonical snapshot
can be written before the DO transaction.

For `patch` with `history = "snapshot"`:

```text
1. Worker forwards patch to DO
2. DO transaction:
   validate fence
   apply merge patch
   validate schema for the patched value
   update records
   insert record_revisions with NULL artifact keys
   append journal
3. Worker uploads canonical JSON for the returned revision value to R2
4. Worker calls DO stamp-artifacts for that revision
5. DO stamp-artifacts transaction:
   verify revision still exists for the record
   update record_revisions artifact keys
   upsert artifact pointer rows
```

This two-phase flow is only needed for patch+snapshot. It avoids a preflight
read/write race and keeps the primary record mutation fully atomic. If artifact
stamping fails, the record revision still exists without snapshot artifact keys.

Failure matrix:

| Flow | Failure | Result | Recovery |
|---|---|---|---|
| set snapshot | R2 fail before DO | no write | client retries |
| set snapshot | R2 ok, DO fail | orphan R2 blob | orphan cleanup |
| set snapshot | R2 ok, DO ok | clean write | none |
| patch snapshot | first DO fail | no write | client handles error |
| patch snapshot | first DO ok, R2 fail | revision without artifacts | graceful degradation |
| patch snapshot | R2 ok, stamp DO fail | orphan R2 blob | orphan cleanup |
| patch snapshot | all ok | clean write with artifact keys | none |

If the CLI preuploads a source artifact and the later record mutation fails, the
source artifact may remain as a normal tracked artifact pointer without a record
revision referencing it. This is acceptable in v0.1; it is not a dangling DO
reference to a missing R2 object.

Invariant:

```text
DO never references an R2 key that failed to write.
```

Orphan R2 blobs are acceptable and recoverable. Dangling DO references to
missing R2 blobs are not acceptable.

## Fences And Mutation Semantics

Use the existing `fences` table with resource names:

```text
record:<type>/<key>
```

### Creation

`record set` without a fence is create-only.

Rules:

```text
set without fence:
  create record
  fail 409 if record already exists
  create/increment fence in same DO transaction
  return initial fence = 1
  insert record_revisions.operation = "created"
  emit record.created
```

Concurrent creates are first-writer-wins through the SQLite primary key and DO
serialization. The loser gets 409 and must `get` the current record/fence.

### Full Replace

`record set` with a fence is update-only.

Rules:

```text
set with fence:
  require existing record
  validate fence
  replace value_json entirely
  increment fence
  increment revision
  insert record_revisions.operation = "set"
  emit record.updated
```

### Merge Patch

`record patch` is update-only and requires a fence.

Use RFC 7396 JSON Merge Patch.

Rules:

```text
objects merge recursively
arrays replace whole
null deletes a field
YAML ~ deletes a field
literal null requires full set
```

Successful patch revisions use `record_revisions.operation = "patch"`.

Examples:

```bash
tila record patch service api --json '{"owner":"platform"}' --fence 13
tila record patch service api ./partial-update.yaml --fence 13
```

### Archive And Unarchive

Records are tombstoned, not hard-deleted.

```text
archive:
  require existing record
  require fence
  fail 409 invalid-state if already archived
  set archived = 1
  increment fence and revision
  insert record_revisions.operation = "archived"
  emit record.archived

unarchive:
  require existing record
  require fence
  fail 409 invalid-state if already active
  set archived = 0
  increment fence and revision
  insert record_revisions.operation = "unarchived"
  emit record.unarchived
```

Archive/unarchive revisions should store the same `value_json` as the current
record, with revision metadata and journal event distinguishing the state
transition.

Hard delete/purge is deferred.

## Query Model

v0.1 supports simple coordinate-based queries:

```text
get(type, key)
list(type)
list(type, tag)
list(type, dataFilter)
types
types --in-use
```

### List Requires Type

Require `type` for `record list` in v0.1. Do not ship global `record list`
across all types except `record types --in-use`.

### Tags

Tags are metadata, not identity.

Examples:

```text
repo:api-service
team:platform
env:staging
package:auth
```

`record_tags` is a separate indexed table. Do not store tags only as a JSON
array on `records`.

Validation:

```text
Regex:    ^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,63}$
Max tags: 20 per record
Storage:  lowercase normalized
```

Deduplicate tags case-insensitively at write time after lowercasing.

### Tag Mutation Semantics

Create:

```text
tags omitted -> empty tag set
tags provided -> insert exactly those tags
```

Full set/update:

```text
tags omitted -> preserve existing tag set
tags provided -> replace entire tag set with the provided tags
```

Patch:

```text
does not mutate tags in v0.1
```

Future commands may add explicit tag operations:

```bash
tila record tag add service api repo:api-service
tila record tag remove service api repo:api-service
```

Do not implement tag add/remove commands in v0.1 unless needed by the initial
record implementation.

### Data Filters

`dataFilter` supports top-level field equality only.

API shape:

```text
?filter={"owner":"platform"}
```

The value is a URL-encoded JSON object. Filter values are JSON scalars. Do not
accept object or array filter values in v0.1.

Implementation should reuse the existing entity `dataFilter` pattern:

```sql
json_extract(value_json, '$.<field>') = <value>
```

Normalize the scalar comparison value the same way the existing entity filter
does: bind `JSON.stringify(value)` as the comparison value. If this behavior is
changed in the shared filter helper, entities and records must change together.

CLI shape:

```bash
tila record list service --filter owner=platform
```

In v0.1, CLI filter values are strings. Typed CLI filter parsing such as
`replicas:number=3` is deferred.

Do not add a nested path query API in v0.1, even though SQLite supports
`json_extract` paths.

### List Envelope

All list responses use a pagination-ready envelope:

```json
{
  "ok": true,
  "items": [],
  "meta": {
    "total": 0,
    "limit": 200,
    "next_cursor": null
  }
}
```

Rules:

```text
hard cap limit = 200
next_cursor always present
query LIMIT 201 internally
next_cursor = null when the full result fits in the page
next_cursor = "truncated" when more than 200 rows match
no real cursor pagination in v0.1
```

The response envelope avoids a future breaking change when pagination lands.
When `next_cursor` is `"truncated"`, clients must narrow the query with type,
tag, or filter. A future version can replace `"truncated"` with an opaque cursor
token without changing the response shape.

### Metadata List Shape

`record list` should return metadata by default, not full values:

```json
{
  "type": "service",
  "key": "api",
  "revision": 7,
  "updated_at": 1779090000000,
  "updated_by": "agent-a",
  "archived": 0,
  "tags": ["repo:api-service", "team:platform"]
}
```

Fetch full values with `record get`.

## API Contract

Base:

```text
/projects/:projectId/records
```

Routes:

```text
GET    /projects/:id/records/_types
GET    /projects/:id/records/:type
POST   /projects/:id/records/:type
GET    /projects/:id/records/:type/~/history/:key{.+}
POST   /projects/:id/records/:type/~/archive/:key{.+}
POST   /projects/:id/records/:type/~/unarchive/:key{.+}
GET    /projects/:id/records/:type/:key{.+}
PUT    /projects/:id/records/:type/:key{.+}
PATCH  /projects/:id/records/:type/:key{.+}
```

Use catch-all key routing because keys may contain slashes.

Register `_types` and `~/...` action routes before the catch-all key routes.

`_types` is a reserved route segment. It cannot collide with a valid record type
because record types must start with a lowercase letter. `~` is a reserved
sentinel segment. It cannot collide with a valid key because `~` is excluded by
key validation.

### Create Request

```http
POST /projects/:id/records/:type
```

Body:

```json
{
  "key": "main",
  "value": {
    "name": "main"
  },
  "tags": ["repo:api-service"],
  "message": "initial value",
  "source_artifact_key": null
}
```

No fence. Create-only. Fails 409 if `(type, key)` exists.

`source_artifact_key` is optional and only used for `history = "snapshot"` full
set/create operations. The CLI obtains it by uploading the raw source file
through the artifact upload endpoint before calling the JSON-only record API.

### Set Request

```http
PUT /projects/:id/records/:type/:key{.+}
```

Body:

```json
{
  "value": {
    "name": "main"
  },
  "fence": 1,
  "tags": ["repo:api-service"],
  "message": "replace config",
  "source_artifact_key": null
}
```

Fence required. Update-only.

Clients do not supply `canonical_artifact_key`. For snapshot-mode full set, the
Worker canonicalizes the submitted JSON value and writes the canonical artifact
before forwarding the mutation to the DO.

If `source_artifact_key` is provided, validate that the record type uses
`history = "snapshot"` and that the artifact pointer exists with system kind
`record-snapshot-source` for resource `record:<type>/<key>`.

### Patch Request

```http
PATCH /projects/:id/records/:type/:key{.+}
```

Body:

```json
{
  "patch": {
    "owner": "platform",
    "timeout": null
  },
  "fence": 2,
  "message": "update owner and remove timeout"
}
```

Fence required. Uses JSON Merge Patch.

### Archive Request

```http
POST /projects/:id/records/:type/~/archive/:key{.+}
```

Body:

```json
{
  "fence": 3,
  "message": "service retired"
}
```

Tombstones only.

### Unarchive Request

```http
POST /projects/:id/records/:type/~/unarchive/:key{.+}
```

Body:

```json
{
  "fence": 4,
  "message": "service restored"
}
```

Restores an archived record to active state.

### Get Response

Explicit `get` returns archived records and includes the current fence. The
fence is top-level so callers can read and then perform a fenced mutation.

```json
{
  "ok": true,
  "record": {
    "type": "service",
    "key": "api",
    "schema_version": 1,
    "value": {
      "owner": "platform"
    },
    "value_sha256": "abc123...",
    "revision": 4,
    "archived": 0,
    "created_at": 1779090000000,
    "updated_at": 1779090100000,
    "updated_by": "agent-a",
    "tags": ["repo:api-service"]
  },
  "fence": 4
}
```

### Response Shape

Mutating responses return the updated record, fence, and revision:

```json
{
  "ok": true,
  "record": {
    "type": "service",
    "key": "api",
    "schema_version": 1,
    "value": {
      "owner": "platform"
    },
    "value_sha256": "abc123...",
    "revision": 4,
    "archived": 0,
    "created_at": 1779090000000,
    "updated_at": 1779090100000,
    "updated_by": "agent-a",
    "tags": ["repo:api-service"]
  },
  "fence": 4,
  "revision": 4
}
```

### History Response

Default history is metadata-only, newest first.

```http
GET /projects/:id/records/:type/~/history/:key{.+}
```

Query:

```text
?limit=20&values=false
```

Response:

```json
{
  "ok": true,
  "items": [
    {
      "type": "pipeline_config",
      "key": "main",
      "revision": 3,
      "operation": "patch",
      "schema_version": 1,
      "value_sha256": "e3b0c442...",
      "canonical_artifact_key": "record-snapshots/...",
      "source_artifact_key": null,
      "actor": "agent-a",
      "created_at": 1779090000000,
      "message": "apply patch"
    }
  ],
  "meta": {
    "total": 3,
    "limit": 20,
    "next_cursor": null
  }
}
```

When `values=true`, include `value` for each revision.

### Error Contract

All errors use the existing envelope:

```json
{
  "ok": false,
  "error": {
    "code": "stale-fence",
    "message": "fence is stale",
    "retryable": false
  }
}
```

| Condition | Status | `error.code` | `retryable` |
|---|---:|---|---|
| invalid type/key format | 400 | `validation-error` | false |
| body is not a JSON object | 400 | `validation-error` | false |
| record type not in schema | 422 | `undeclared-type` | false |
| required field missing or type mismatch | 422 | `constraint-violation` | false |
| record not found | 404 | `not-found` | false |
| duplicate create | 409 | `already-exists` | false |
| stale or missing fence | 409 | `stale-fence` | false |
| archive already archived / unarchive already active | 409 | `invalid-state` | false |
| value exceeds 64 KiB | 413 | `payload-too-large` | false |
| internal failure | 500 | `internal` | true |

## CLI Contract

Commands:

```bash
tila record set <type> <key> <file> [--fence <n>] [--tag <tag>]... [--message <msg>] [--json]
tila record get <type> <key> [--format json|yaml] [--json]
tila record list <type> [--tag <tag>] [--filter <k=v>] [--include-archived] [--json]
tila record patch <type> <key> <file|--json <json>> --fence <n> [--message <msg>]
tila record archive <type> <key> --fence <n> [--message <msg>]
tila record unarchive <type> <key> --fence <n> [--message <msg>]
tila record history <type> <key> [--values] [--limit <n>] [--json]
tila record export <type> --output-dir <dir> [--format json|yaml]
tila record export --all --output-dir <dir> [--format json|yaml]
tila record types [--in-use] [--json]
```

Where `--json` appears as a standalone flag, it controls command output format.
For `record patch`, `--json <json>` is the inline patch payload.

### `set`

No `--fence` means create-only.

With `--fence` means update-only.

Input file may be JSON or YAML.

For `history = "snapshot"` record types, the CLI preserves original source bytes
only for full `set` file inputs:

```text
1. upload raw file through the artifact endpoint as kind record-snapshot-source
2. parse JSON/YAML locally
3. send canonical JSON value plus source_artifact_key to the record API
```

For non-snapshot record types, skip the source upload.

### `patch`

Accepts inline JSON or a JSON/YAML patch file.

```bash
tila record patch service api --json '{"owner":"platform"}' --fence 13
tila record patch service api ./partial-update.yaml --fence 13
```

### `get`

Default output format uses the record type's `format` declaration.

Override:

```bash
tila record get pipeline_config main --format json
```

### `list`

Default list output is metadata-only. `--json` preserves the API envelope.

`--filter owner=platform` sends a top-level string equality filter. Typed CLI
filter parsing is deferred.

### `history`

Default:

```text
metadata-only
newest first
limit 20
```

`--values` includes full values.

Defer `record diff`.

### `export`

Export is launch scope.

```bash
tila record export service --output-dir ./export/service
tila record export --all --output-dir ./export
```

Rules:

- current values only
- one file per record
- no revision history
- no backend endpoint required; compose list + get
- format uses schema-declared format by default unless overridden

For keys with slashes, create nested directories or escape filenames. Prefer
nested directories because keys are already path-like. Key validation forbids
empty, `.` and `..` segments so export implementations must not need path
traversal cleanup for valid keys.

### `types`

```bash
tila record types
tila record types --in-use
```

Default reads declared types from current schema. `--in-use` reads distinct
active types from the `records` table:

```sql
SELECT DISTINCT type FROM records WHERE archived = 0;
```

Do not count archived-only types in v0.1. Add `--include-archived` later if a
real use case appears.

## MCP Contract

### Tools

Expose record operations as MCP tools:

```text
tila_record_get
tila_record_set
tila_record_patch
tila_record_list
tila_record_archive
tila_record_unarchive
tila_record_history
```

`tila_record_list` returns metadata only, not full values.

### Resources

Records are MCP resources only when opted in by schema:

```toml
[records.pipeline_config]
mcp_resource = true
```

URI template:

```text
tila://records/{type}/{key}
```

Percent-encode keys when constructing MCP resource URIs:

```text
type=service, key=api/staging -> tila://records/service/api%2Fstaging
```

The MCP server decodes the final URI segment with `decodeURIComponent` before
lookup.

Default:

```text
mcp_resource = false
```

Rationale: agents should pull records on demand with tools. Automatically
injecting all records floods context. Only small, critical records such as
agent policy or pipeline config should opt into MCP resources.

## Work-Unit Public Rename

When adding records, fix public vocabulary:

```text
entity -> work unit
```

Do now:

- add `tila work-unit` generic CLI command
- keep `tila task` as a task-specific convenience alias
- add `/projects/:id/work-units`
- keep `/projects/:id/entities` as a deprecated alias temporarily
- add `client.workUnits.*` in SDK
- add generic `tila_work_unit_*` MCP tools
- keep `tila_task_*` MCP tools as aliases/deprecated task-specific tools

Do later:

- rename internal `entity-ops.ts`
- rename internal TypeScript `Entity` types
- rename SQLite `entities` table only if there is a compelling reason

The internal table name is an implementation detail and does not need to block
the public rename.

## Schema Evolution

Records follow the same model as work units:

```text
tolerant read by stored schema_version
validated write against current schema
diffSchemas classifies changes
```

Record rows store `schema_version`. On successful mutation, update the
record's `schema_version` to the current schema version.

Record revision rows also store `schema_version`, because history reads with
`values=true` must interpret each stored value against the schema that was
current at the time of that revision.

Change classification:

| Change | Classification |
|---|---|
| add record type | auto-applicable |
| remove record type | destructive if any active or archived records exist |
| add optional field | auto-applicable |
| add required field with default_for_legacy | auto-applicable |
| add required field without default_for_legacy | destructive |
| remove field | destructive |
| change field type | destructive |
| change format | presentation-only, auto-applicable |
| change history | auto-applicable for future revisions |
| change writers | advisory, auto-applicable in v0.1 |
| add/change schema_ref | reserved, auto-applicable in v0.1 |

Implementation shape:

```ts
type SchemaFieldChange = {
  scope: "work-unit" | "record";
  typeName: string;
  fieldName: string;
  // existing field change detail
};

type SchemaRecordChange =
  | { kind: "record-type-added"; recordType: string }
  | { kind: "record-type-removed"; recordType: string; recordCount: number };
```

Do not overload `unitType` for records.

## Security And Secrets

Records are plaintext coordinated project state.

Rules:

- Do not store secrets in records.
- Do not store tokens, passwords, private keys, or raw credentials.
- Store references to external secret managers instead.

Example:

```json
{
  "deploy_secret_ref": "aws/production/deploy"
}
```

Why:

- records are visible to all agents with project read access
- revisions preserve old values
- journal events and exports increase exposure
- v0.1 has shared-token auth in many deployments

`writers` is advisory only in v0.1. Fences solve concurrency, not
authorization. `actor` is an audit field, not a security boundary.

## Repo Files And Sync

Records are coordination state, not a filesystem.

Do not implement bidirectional repo sync in v0.1.

Recommended workflow for git-reviewable config:

```text
1. keep YAML/JSON in the repo
2. review it through git/PRs
3. CI or a human runs tila record set from that file
4. agents read the live value from tila
```

One-way flow:

```text
git file -> tila record
```

Do not implement:

- `.tila/records` working tree mirror
- automatic write-back to repo
- conflict-prone two-way sync

## Portability

Records are portable by design:

- canonical JSON storage
- schema in `tila.schema.toml`
- `tila record export` writes current values
- future export can include history

Cloudflare lock-in is in the coordination runtime (DO serialization, fences,
journal, R2 lifecycle), not the data format.

## Implementation Plan

### Phase 1: Schemas

Files likely touched:

- `packages/schemas/src/config.ts`
- `packages/schemas/src/api.ts`
- `packages/schemas/src/index.ts`
- `packages/core/src/schema-parser.ts`
- `packages/core/src/schema-evolution.ts`

Tasks:

1. Add `RecordTypeSchema` and `RecordKeySchema`.
2. Add `RecordTagSchema`.
3. Add canonical JSON serializer and SHA-256 helper.
4. Add `RecordDefinitionSchema`.
5. Extend field declarations with `number`, `boolean`, `json`.
6. Add API schemas for record create/set/patch/list/history/error responses.
7. Enforce 64 KiB canonical value size.
8. Extend schema parser and semantic checks.
9. Extend `diffSchemas` with record changes.

### Phase 2: DO SQLite

Files likely touched:

- `packages/ops-sqlite/src/schema.ts`
- `packages/ops-sqlite/src/migrations-sql.ts`
- `packages/backend-do/migrations/do/*.sql`
- new `packages/ops-sqlite/src/record-ops.ts`
- `packages/backend-do/src/project-do-router.ts`

Tasks:

1. Add `records`, `record_tags`, `record_revisions` tables.
2. Add record ops:
   - create
   - set
   - patch
   - archive
   - unarchive
   - get
   - list
   - history
   - types in use
   - stamp artifacts for patch+snapshot
3. Store `operation` and `schema_version` on every revision.
4. Reuse shared fence validation with `record:<type>/<key>`.
5. Reuse/extract JSON `dataFilter` builder from entity ops.
6. Upsert artifact pointer rows for snapshot artifacts.
7. Append journal events inside transactions.

### Phase 3: Worker Routes

Files likely touched:

- new `packages/worker/src/routes/records.ts`
- `packages/worker/src/index.ts`
- `packages/worker/src/lib/normalize-text.ts` only if snapshot text normalization is reused

Tasks:

1. Add `/projects/:projectId/records` routes.
2. Validate type/key at Worker/API boundary.
3. Keep API JSON-only.
4. Register `_types` and `~/...` action routes before catch-all key routes.
5. Implement R2-first snapshot write path for full set.
6. Implement two-phase patch+snapshot stamping.
7. Validate source artifact keys when provided.
8. Forward DO operations with actor and token id.

### Phase 4: CLI

Files likely touched:

- new `packages/cli/src/commands/record.ts`
- `packages/cli/src/index.ts`
- CLI output utilities

Tasks:

1. Add `tila record` command group.
2. Parse JSON/YAML files at CLI edge.
3. Preupload full source files for snapshot-mode `set`.
4. Implement `set`, `get`, `list`, `patch`, `archive`, `unarchive`,
   `history`, `export`, `types`.
5. Add JSON output flags consistently, avoiding collision with patch's
   `--json <json>` payload flag.
6. Add YAML output for `get` and `export`.

### Phase 5: SDK And MCP

Files likely touched:

- `packages/sdk/src/records.ts`
- `packages/sdk/src/index.ts`
- `packages/mcp-server/src/tools/records.ts`
- `packages/mcp-server/src/resources/index.ts`

Tasks:

1. Add `client.records.*`.
2. Add MCP record tools.
3. Add opt-in MCP resources for `mcp_resource = true`.
4. Ensure list tools return metadata only.
5. Percent-encode record keys in MCP resource URIs.

### Phase 6: Public Work-Unit Alias

Files likely touched:

- `packages/worker/src/routes/entities.ts`
- `packages/cli/src/commands/*`
- `packages/sdk/src/entities.ts`
- MCP tools

Tasks:

1. Add `/work-units` alias routes.
2. Keep `/entities` as deprecated alias.
3. Add generic `tila work-unit` CLI command.
4. Keep `tila task` working.
5. Add `client.workUnits.*` as public SDK alias.

## Testing Checklist

Unit tests:

- schema parser accepts `[records.*]`
- type/key/tag validation, including invalid path segments
- canonical JSON serializer sorts object keys recursively
- 64 KiB value limit
- declared record type with no fields accepts any JSON object
- JSON/YAML parsing in CLI
- field validation for string/text/enum/list<string>/number/boolean/json
- merge patch semantics, including null delete and array replacement
- schema evolution classification
- record resource name parser

DO/ops tests:

- create without fence succeeds and returns fence 1
- duplicate create without fence returns 409
- set with stale fence returns 409
- patch with stale fence returns 409
- archive/unarchive require fence
- list excludes archived by default
- get returns archived records
- tag filtering
- dataFilter top-level equality
- history newest-first with limit
- revisions increment on each mutation
- revisions store operation and schema_version
- patch+snapshot stamp-artifacts updates only the intended revision
- system artifact pointer rows are created for snapshots

Worker tests:

- API rejects invalid type/key
- API accepts JSON only
- action routes using `~/...` do not collide with catch-all keys
- full set snapshot writes R2 before DO
- patch snapshot records revision before artifact stamping
- DO failure after R2 success leaves orphan artifact only
- source_artifact_key validation
- list envelope shape
- list returns next_cursor "truncated" when more than 200 rows match
- history `values=false` and `values=true`
- error code/status contract

CLI tests:

- set JSON file
- set YAML file
- set YAML snapshot preuploads source artifact
- patch inline JSON
- patch YAML file
- get YAML output
- get JSON output
- export type
- export all
- export keys with slash as safe nested paths
- types and types --in-use

MCP tests:

- list returns metadata only
- get returns full value
- unarchive tool exists
- mcp_resource false by default
- mcp_resource true exposes resource template
- resource URI percent-encodes slash-containing keys

## Deferred Work

- hard delete / purge
- TTL / auto-archive
- JSON Schema validation via `schema_ref`
- spec/status enforcement
- controller/reconciler runtime
- JSON Patch RFC 6902
- path-set CLI sugar
- per-path fences
- three-way merge
- pagination cursors
- indexed JSON paths
- full-text search over record values
- record relationships table
- bidirectional git sync
- history export
- record diff
