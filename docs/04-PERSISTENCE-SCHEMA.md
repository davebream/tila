# tila — persistence schema

Visual reference for the data model in the DO-first three-layer architecture. This diagram lives alongside the architecture document and is the single source of truth for table relationships and cross-store edges. When the schema changes, this file updates with it.

## ER diagram (DO SQLite + global D1 + R2)

```mermaid
erDiagram
    %% --- per-project DO SQLite tables ---
    entities ||--o{ entity_relationships : "from_id / to_id"
    entities ||--o{ entity_artifact_references : "consults"
    entities ||--o{ artifact_pointers : "produces (resource FK)"

    entity_artifact_references }o--|| artifact_pointers : "references"

    artifact_pointers ||--o{ artifact_relationships : "from_key / to_key"
    artifact_pointers ||--|| R2_object : "r2_key"

    claims }o--o{ entities : "resource string"
    fences }o--o{ entities : "resource string"

    journal }o--o{ entities : "resource string (audit)"
    journal }o--o{ artifact_pointers : "resource string (audit)"

    %% --- global D1 tables ---
    _projects ||--o{ _tokens : "project_id"
    _projects }o--o{ entities : "PROJECT_ID = DO name"

    entities {
        text id PK
        text type "work_units type"
        int schema_version
        json data "passthrough preserved"
        int archived
        int created_at
        int updated_at
        text created_by
    }

    entity_relationships {
        text from_id PK_FK "entity ID - CHECK no slashes"
        text to_id PK_FK "entity ID - CHECK no slashes"
        text type PK "parent-child or blocks etc"
        int schema_version
        int created_at
    }

    entity_artifact_references {
        text entity_id PK_FK "CHECK no slashes"
        text artifact_key PK_FK "CHECK has slashes"
        text slot PK "declared in schema"
        json metadata
        int created_at
    }

    artifact_pointers {
        text r2_key PK "CHECK has slashes"
        text resource FK "NULL for source artifacts"
        text kind "artifacts type"
        text sha256
        int bytes
        int fence "NULL for sources"
        text mime_type
        int produced_at
        text produced_by
        int expires_at "NULL keeps indefinitely"
        int tombstoned "1 when R2 blob deleted"
    }

    artifact_relationships {
        text from_key PK_FK
        text to_key FK "or to_uri for external"
        text to_uri "non-NULL if external"
        text type PK "references or supersedes etc"
        json metadata
        int created_at
    }

    journal {
        int seq PK "autoincrement"
        int t "unix ms"
        text kind "event type"
        text resource "soft link"
        text actor
        int fence
        json data "event payload"
    }

    claims {
        text resource PK
        text holder
        text mode "exclusive or owner or presence"
        int fence "value at acquire time"
        int acquired_at
        int expires_at
        json metadata
    }

    fences {
        text resource PK
        int current_fence "monotonic - never decrements"
    }

    presence {
        text machine PK
        int last_seen "60s TTL by default"
        json info "current resource and status"
    }

    _do_idempotency {
        text key PK "worker composite caller-scoped key"
        text request_hash "body sha256, nullable"
        int status_code
        text response_json "stored domain result"
        int created_at
    }

    R2_object {
        text key PK "content-addressed path"
        blob body "content-addressed"
        map metadata "tila custom headers"
    }

    _projects {
        text project_id PK "also the DO name"
        text display_name
        int created_at
        text cloudflare_account_id
        int schema_version "cached from DO"
        int archived
    }

    _tokens {
        text token_hash PK "Argon2id"
        text project_id FK
        text name "unique within project"
        text scopes "full in v0.1"
        int created_at
        int last_used_at
        int revoked_at
    }

    _idempotency {
        text key PK
        text project_id
        int created_at
        text response_json
        int status_code
    }
```

## How to read it

**One DO per project.** Every table outside `_projects`, `_tokens`, `_idempotency` lives inside the project's Durable Object's SQLite storage. There is one DO instance per tila project. All per-project state — entities, relationships, artifacts metadata, claims, journal, schema history — is in this DO. The DO is reachable only through the Worker; access goes through Cloudflare's serialization, which is what makes single-transaction claim+entity+journal writes safe.

**Global D1 is small and narrow.** `_projects`, `_tokens`, `_idempotency` live in a single global D1 instance shared across all tila projects in a Cloudflare account. The Worker reads these to authenticate requests and route to the right DO. They're separate because they have cross-project scope (an account-wide token registry; idempotency keys that may span requests across DOs).

**Solid lines are foreign-key relationships inside one storage layer.** Within DO SQLite, `entities.id` is referenced by `entity_relationships.from_id`/`to_id`, `entity_artifact_references.entity_id`, and `artifact_pointers.resource`. Within global D1, `_projects.project_id` is referenced by `_tokens.project_id`.

**Dashed/soft lines (`}o--o{`) are cross-store or string-based references.** `journal.resource` is a string like `task:T-142`; it is not an enforced FK because the journal is append-only and must survive the archival of the entity it references. `claims.resource` and `fences.resource` reference entities by string for the same reason — fence counters must persist after entities are deleted to prevent reuse.

**The R2 boundary.** `artifact_pointers` is the DO record; `R2_object` is the blob. The R2 key is the linkage. Maintaining consistency across this boundary is the Worker's job: every artifact write is R2 first (content-addressed, idempotent), then DO transaction (pointer row + journal event + required-reference edges). Failure between the two is reconciled on next `tila doctor --reconcile`. See Architecture §3a.6.

**Two idempotency tables, two layers.** The global D1 `_idempotency` is the Worker's fast-path dedup, written *after* the DO write commits. `_do_idempotency` is a DO-only table (migration v21) written *inside* the same DO SQLite transaction as a fence-mutating write, so a retry after a crash between the DO commit and the D1 store still short-circuits without double-applying (audit B1); the D1 row is an optimization, not the sole guard. Embedded mode has neither of these — it uses its own single-file `_idempotency` overlay and does NOT create `_do_idempotency`. See Architecture §3a.3.

## Why the DO-first split

The 2024 design held entities in D1 and only coordination state in the DO. The 2026 design unifies them. Three reasons:

1. **Claim + entity + journal in one transaction.** Claiming a task and updating its status used to require Worker-coordinated writes across two backends (D1 entity update, DO claim acquire, D1 journal append). Now it's one DO SQLite transaction. The two-write problem dissolves.
2. **Latency.** D1 reads from a Worker are ~30ms. DO SQLite reads from inside the DO are <1ms. Most operations touch both entity state and claim state; co-locating them drops the hot path 5-10x.
3. **Free tier headroom.** D1's 100K writes/day free tier was a real constraint at autopilot rates. DO storage has different (more generous for active projects) limits.

D1 still exists for things that genuinely need cross-project scope: API tokens (must be readable before contacting any DO, to authenticate), idempotency keys (cross-request scope), project registry (a directory of projects in the account).

## Two artifact flavors, one table

`artifact_pointers` holds both produced artifacts and source artifacts. The discriminator is `resource`:

| Flavor | `resource` | `fence` | R2 prefix | Lifecycle |
|---|---|---|---|---|
| Produced | `task:T-142` (or any work-unit type prefix) | non-NULL (claim was held) | `tasks/T-142/<sha>.ext` (per work-unit type) | `expires_at` set from schema's per-kind `retention_days` |
| Source | NULL | NULL (no claim held during upload) | `sources/<sha>.ext` | `expires_at` NULL = keep indefinitely |

A consumer reading `artifact_pointers` filters on `WHERE resource IS NOT NULL` for produced artifacts or `WHERE resource IS NULL` for project-level sources. Two partial indexes keep both queries fast.

## Three relationship tables, three distinct directions

```
entity_relationships:        work unit  ↔  work unit       (hierarchy, dependencies)
entity_artifact_references:  work unit  →  artifact         (work unit consults artifact)
artifact_relationships:      artifact   ↔  artifact         (or → external URI; citations)
```

Why three and not one polymorphic table:
- **Different cardinality contracts.** `entity_relationships` is unique on `(from, to, type)`. `entity_artifact_references` is unique on `(entity, artifact, slot)` — same artifact can be in multiple slots if a consumer declares them. `artifact_relationships` permits external `to_uri` for crossing the project boundary.
- **Different validation rules.** Parent-child edges check hierarchy depth and leaf constraints. Entity-artifact references check declared slot kinds. Artifact relationships check declared relationship types only.
- **Different query patterns.** Hierarchy traversal walks `entity_relationships`. "What sources does this task consult?" walks `entity_artifact_references`. "What artifacts cite this one?" walks `artifact_relationships`. Each is a single-table query.
- **CHECK constraints prevent cross-confusion.** Entity-ID columns reject values containing `/` (R2 keys always have slashes). Artifact-key columns require slashes. Database-level enforcement, not application discipline.

## What lives in the DO is the durable record

DO SQLite is the source of truth for everything per-project. It is *not* a cache or mirror.

- **Claims:** persisted, not transient. The single-DO transaction model means claim acquisition is the same kind of write as entity creation.
- **Fences:** persisted indefinitely. Even after a resource is deleted, its fence counter survives (so future re-creates don't reuse fence numbers).
- **Journal:** the audit log. Append-only, durable, recoverable via Cloudflare's DO SQLite point-in-time recovery.
- **Presence:** the one mostly-ephemeral table. Refreshed on heartbeat, reaped by the sweeper. Crashes are recoverable (machines re-register).

If a DO is wiped (catastrophic incident with no PIT recovery), the recovery story is:
- **Artifacts are recoverable from R2 + object metadata.** `tila doctor --reconcile` walks R2 and synthesizes `artifact_pointers` rows from `x-amz-meta-tila-*` metadata.
- **Entities, relationships, and journal are NOT recoverable from R2 alone.** v0.1 relies on Cloudflare's DO SQLite PIT recovery. External journal backups to R2 are a v0.2 feature.

## Cross-store consistency boundaries

| Operation | DO SQLite write | R2 write | Global D1 write | Ordering |
|---|---|---|---|---|
| Create entity | `entities` INSERT + `journal` INSERT | — | — | one transaction |
| Add work-unit-to-work-unit relationship | `entity_relationships` INSERT + `journal` INSERT | — | — | one transaction |
| Claim resource | `claims` INSERT + `fences` UPDATE + `journal` INSERT | — | — | one transaction (the 2024 D1-and-DO split is gone) |
| Put produced artifact | `artifact_pointers` INSERT + (optional) `artifact_relationships` INSERT + `journal` INSERT | R2 PUT with `If-None-Match: *` | `_idempotency` INSERT | R2 first (idempotent), then DO transaction, then D1 idempotency cache. Cross-backend; reconcile recovers. |
| Put source artifact | `artifact_pointers` INSERT (resource NULL) + `journal` INSERT | R2 PUT with `If-None-Match: *` | `_idempotency` INSERT | same as produced; no fence check |
| Add entity-artifact reference | `entity_artifact_references` INSERT + `journal` INSERT | — | — | one transaction |
| Apply schema | `_schema_history` INSERT + (possibly entity backfill) | — | `_projects.schema_version` UPDATE | DO transaction first, then global D1 update; doctor reconciles drift |
| Issue API token | — | — | `_tokens` INSERT | atomic within global D1 |
| Sweep expired artifacts (cron) | `artifact_pointers` UPDATE (tombstone) + `journal` INSERT per artifact | R2 DELETE per artifact | — | per artifact: R2 first, then DO update |

## Open questions the diagram surfaces

These are worth confirming or deferring; the diagram makes them visible:

1. **`artifact_relationships.to_uri` for external references.** Same row can carry `to_key` (internal) or `to_uri` (external URL, GitHub PR, doc). The PRIMARY KEY uses `COALESCE(to_key, to_uri)`. Lean: keep both; removing later is trivial, adding later requires schema migration.

2. **`entity_artifact_references.slot` cardinality.** PRIMARY KEY is `(entity_id, artifact_key, slot)`. This allows the same artifact in multiple slots on the same entity. Lean: allow it; harmless, and a future consumer might rely on it.

3. **`journal.resource` as a soft reference.** Journal events outlive entities and artifacts (archive doesn't delete journal). Worth being explicit in `tila doctor` output: "12 journal events reference resources that no longer exist (expected after archives)."

4. **Source artifacts referenced by archived entities.** A source uploaded for E-5 (archived) is still in R2. The `entity_artifact_references` row still exists. `tila source list --orphaned` could surface "no longer referenced by any active entity, consider `tila source delete`." Deferred to v0.2; data model already supports the query.

5. **`fence` on source artifacts is NULL.** Deviation from "every artifact has a fence." It's correct (no claim is held during source upload) but consumers reading `artifact_pointers` must handle NULL fence for sources. Documented in Architecture §7.

6. **Idempotency table cleanup.** Rows accumulate per mutating request. v0.1 ships with a daily cron-driven cleanup that removes rows older than 24h. Lives in the global D1 sweep, not the per-project DO sweep.

7. **`_tokens.last_used_at` updates.** Updating on every API call adds write load. Acceptable for 3-6 machines × a few hundred calls/hour. v0.2 may move to "update on first call of the hour" if write rate becomes a concern.

8. **Tombstoned pointer rows.** When the Worker-driven sweep deletes an R2 blob, the pointer row is kept with `tombstoned = 1` for audit. These accumulate forever in v0.1. Pruning policy is v0.2+ — likely "drop tombstones older than 1 year."

## What the diagram makes obvious

Looking at the structure end-to-end, three things stand out:

**The DO is the heart.** Almost every table is in DO SQLite. The D1 piece is small (3 tables) and narrowly scoped. R2 holds blobs and nothing else. This is the cleanest expression of "one project = one DO" — every write that needs project-level consistency goes through the same single-threaded SQLite database.

**The cross-store edge is narrow.** R2 connects to DO through exactly one column: `artifact_pointers.r2_key`. Every R2 object should have exactly one pointer row, and every non-tombstoned pointer row should reference exactly one R2 object. If this invariant breaks, `tila doctor` detects it and reports orphans on either side.

**The audit trail is unified.** All meaningful state changes emit a journal row in the same transaction as the change itself. There's no journal-vs-state-table drift to worry about because the journal IS in the same SQLite database as the state. This is the largest 2024-vs-2026 improvement: the old design split journal across two backends (D1 for durability, DO for fast queries), creating a class of consistency bugs that simply cannot occur now.
