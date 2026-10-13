# tila — persistence schema

Visual reference for the data model in the DO-first three-layer architecture. This diagram lives alongside the architecture document and is the single source of truth for table relationships and cross-store edges. When the schema changes, this file updates with it.

## ER diagram (DO SQLite + global D1 + R2)

```mermaid
erDiagram
    %% --- per-project DO SQLite tables ---
    entities ||--o{ entity_relationships : "from_id / to_id"
    entities ||--o{ entity_artifact_references : "consults"
    entities ||..o{ artifact_pointers : "task resource guards"

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
        text resource "Task ID, record resource, or NULL"
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
        text principal_id
        text participant_id
        json environment
        text token_id "credential audit"
        int fence
        json data "event payload"
    }

    claims {
        text resource PK
        text principal_id
        text participant_id
        json environment
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
        text principal_id PK
        text participant_id PK
        json environment
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

**One DO per project.** Every table outside the global D1 set (see below) lives inside the project's Durable Object's SQLite storage. There is one DO instance per tila project. All per-project state — entities, relationships, artifacts metadata, claims, journal, schema history — is in this DO. The DO is reachable only through the Worker; access goes through Cloudflare's serialization, which is what makes single-transaction claim+entity+journal writes safe.

**Global D1 is narrow.** The global D1 instance holds 14 account-wide tables shared across all tila projects in a Cloudflare account: `_projects`, `_tokens`, `_idempotency`, plus the auth/session tables added for multi-instance auth (`_sessions`, `_project_repos`, `_rate_limits`, `_github_app_config`, `_revoked_jti`, `_revoked_subjects`, `_oidc_principals`, `_admin_grants`, `_deployment_meta`) and canonical authorization (`_project_memberships`, `_membership_events`). The Worker reads these to authenticate requests, resolve current project membership, and route to the right DO. `_project_memberships` has at most one active row per project/principal; `_membership_events` is append-only audit history. Legacy `_admin_grants` and `_oidc_principals` are retained as historical migration inputs, not live authorization sources.

**Solid lines are foreign-key relationships inside one storage layer.** Within DO SQLite, `entities.id` is referenced by `entity_relationships.from_id`/`to_id` and `entity_artifact_references.entity_id`. Within global D1, `_projects.project_id` is referenced by `_tokens.project_id`.

**Dashed/soft lines (`}o--o{`) are cross-store or string-based references.** `journal.resource` is a string like `task:T-142`; it is not an enforced FK because the journal is append-only and must survive the archival of the entity it references. `claims.resource` and `fences.resource` reference entities by string for the same reason — fence counters must persist after entities are deleted to prevent reuse.

**Artifact ownership uses conditional guards.** Migration 41 replaces the task-only foreign key on `artifact_pointers.resource` with database triggers. Task pointers retain existing-owner and deletion/update protection. Canonical snapshot pointers require an existing `record:<type>/<key>` owner; source snapshots may precede record creation. Shared operations validate record resource syntax and require a declared snapshot type for source preuploads.

**The R2 boundary.** `artifact_pointers` is the DO record; `R2_object` is the blob. The R2 key is the linkage. Maintaining consistency across this boundary is the Worker's job: every artifact write is R2 first (content-addressed, idempotent), then DO transaction (pointer row + journal event + required-reference edges). Failure between the two is reconciled on next `tila doctor --reconcile`. See Architecture §3a.6.

**Two idempotency tables, two layers.** The global D1 `_idempotency` is the Worker's fast-path dedup, written *after* the DO write commits. `_do_idempotency` is a DO-only table (migration v21) written *inside* the same DO SQLite transaction as a fence-mutating write, so a retry after a crash between the DO commit and the D1 store still short-circuits without double-applying (audit B1); the D1 row is an optimization, not the sole guard. Embedded mode has neither of these — it uses its own single-file `_idempotency` overlay and does NOT create `_do_idempotency`. See Architecture §3a.3.

## Why the DO-first split

The 2024 design held entities in D1 and only coordination state in the DO. The 2026 design unifies them. Three reasons:

1. **Claim + entity + journal in one transaction.** Claiming a task and updating its status used to require Worker-coordinated writes across two backends (D1 entity update, DO claim acquire, D1 journal append). Now it's one DO SQLite transaction. The two-write problem dissolves.
2. **Latency.** D1 reads from a Worker are ~30ms. DO SQLite reads from inside the DO are <1ms (the `inproc` benchmark tier measures the DO-side cost; see [docs/benchmarks/BASELINE.md](benchmarks/BASELINE.md)). Most operations touch both entity state and claim state; co-locating them drops the hot path 5-10x.
3. **Free tier headroom.** D1's 100K writes/day free tier was a real constraint at autopilot rates. DO storage has different (more generous for active projects) limits.

D1 still exists for things that genuinely need cross-project scope: API tokens (must be readable before contacting any DO, to authenticate), idempotency keys (cross-request scope), project registry (a directory of projects in the account).

## Artifact ownership in one table

`artifact_pointers` holds task artifacts, project-level sources, and record snapshots:

| Flavor | `resource` | `fence` | R2 prefix | Lifecycle |
|---|---|---|---|---|
| Task artifact | `T-142` (bare ID; typed aliases normalize on write) | non-NULL (claim was held) | `produced/T-142/<sha>.ext` | `expires_at` set from schema's per-kind `retention_days` |
| Source | NULL | NULL (no claim held during upload) | `sources/<sha>.ext` | `expires_at` NULL = keep indefinitely |
| Record snapshot | `record:<type>/<key>` | NULL | `produced/record:<type>/<key>/<sha>.ext` | Canonical snapshots have no expiry; source uploads retain their upload policy |

`resource IS NULL` identifies project-level sources. Non-NULL resources include both task artifacts and record snapshots; use the system snapshot kinds to distinguish record snapshots. Source and canonical JSON with identical bytes and extension share one content-addressed pointer.

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

DO SQLite is authoritative for project content and coordination; D1 separately owns project registry/access/runtime credential state, and R2 owns artifact bytes and recovery records. Persistence does not determine product category: a saved lease still expires. See [the settings/lifecycle contract](02-ARCHITECTURE.md#section-14-editable-settings-and-entity-lifecycle-contract-293) for the five categories and their conceptual relationships.

- **Claims:** durably stored but lease-limited. A row remaining on disk after expiry grants no authority. Recovery reacquires with a new fence; it does not resume the old lease. Claim/fence/entity operations that require atomicity stay in one DO transaction.
- **Fences:** persisted indefinitely. Even after a resource is deleted, its fence counter survives (so future re-creates don't reuse fence numbers).
- **Journal:** the audit log. Append-only, durable, recoverable via Cloudflare's DO SQLite point-in-time recovery.
- **Presence:** the one mostly-ephemeral table. It is keyed by `(principal_id, participant_id)`, refreshed on heartbeat, and reaped by the sweeper. Crashes are recoverable (participants re-register).
- **Signals:** `signals` stores sender and typed-target snapshots; `signal_deliveries` stores immutable recipient and acknowledgement identities; `signal_groups` and `signal_group_members` store named principal audiences. Group edits never rewrite prior deliveries.

If a DO is wiped (catastrophic incident with no PIT recovery), the recovery story is:
- **Artifacts are recoverable from R2 + object metadata.** `tila doctor --reconcile` walks R2 and synthesizes `artifact_pointers` rows from `x-amz-meta-tila-*` metadata.
- **Entity state needs a project backup or DO point-in-time recovery.** Ordinary artifact metadata alone cannot reconstruct tasks/relationships. #192 implements full project backup/restore and journal archive recovery; a configuration export is not that backup. Restore invalidates runtime bindings and does not resurrect current D1 authority.

## Cross-store consistency boundaries

| Operation | DO SQLite write | R2 write | Global D1 write | Ordering |
|---|---|---|---|---|
| Create entity | `entities` INSERT + `journal` INSERT | — | — | one transaction |
| Add work-unit-to-work-unit relationship | `entity_relationships` INSERT + `journal` INSERT | — | — | one transaction |
| Claim resource | `claims` INSERT + `fences` UPDATE + `journal` INSERT | — | — | one transaction (the 2024 D1-and-DO split is gone) |
| Put produced artifact | `artifact_pointers` INSERT + (optional) `artifact_relationships` INSERT + `journal` INSERT | R2 PUT with `If-None-Match: *` | `_idempotency` INSERT | R2 first (idempotent), then DO transaction, then D1 idempotency cache. Cross-backend; reconcile recovers. |
| Put source artifact | `artifact_pointers` INSERT (resource NULL) + `journal` INSERT | R2 PUT with `If-None-Match: *` | `_idempotency` INSERT | same as produced; no fence check |
| Add entity-artifact reference | `entity_artifact_references` INSERT + `journal` INSERT | — | — | one transaction |
| Apply schema | `_schema_history` + journal INSERT in one transaction; no automatic entity backfill | — | No D1 update in the current Worker schema route | DO applied revision is authoritative; D1 metadata is not a concurrency token. #296 adds expected-revision checks. |
| Issue API token | — | — | `_tokens` INSERT | atomic within global D1 |
| Sweep artifacts | Versioned deletion intent, tombstones, lifecycle queue and evidence | Durable lifecycle records and byte deletion | — | Versioned intent is durable before byte deletion, with retry/recovery; legacy pointer cleanup retains its separate path. Live versioned heads are protected. |

There is no atomic settings transaction across DO, D1, R2 and hosts. Applied
schema history, access/credential policy and host profile revisions have distinct
owners. A restore-as-new configuration revision changes definitions only; it does
not restore deleted blobs, rewind a host or restore revoked membership. Archive
preserves referenced content/evidence; root project destruction is separate.

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

**The DO is the heart.** Almost every per-project table is in DO SQLite. The D1 piece is narrowly scoped (14 tables: account-wide auth, membership, routing, idempotency, and session/revocation state). R2 holds blobs and nothing else. Membership tables and the new `_projects.membership_mode`, repository adapter columns, and session role/source columns are included in D1 backup/restore allowlists and validation.

**The cross-store edge is narrow.** R2 connects to DO through exactly one column: `artifact_pointers.r2_key`. Every R2 object should have exactly one pointer row, and every non-tombstoned pointer row should reference exactly one R2 object. If this invariant breaks, `tila doctor` detects it and reports orphans on either side.

**The audit trail is unified.** All meaningful state changes emit a journal row in the same transaction as the change itself. There's no journal-vs-state-table drift to worry about because the journal IS in the same SQLite database as the state. This is the largest 2024-vs-2026 improvement: the old design split journal across two backends (D1 for durability, DO for fast queries), creating a class of consistency bugs that simply cannot occur now.


## Artifact provenance and reviews (migration 29)

`artifact_pointers.provenance` and `revision_creation` are nullable JSON columns.
They contain principal ID, participant ID, creation timestamp, client name/version,
and environment metadata. SQLite rejects modifications to these columns after
insertion. Legacy display names remain compatibility fields, not verified identity.

`artifact_reviews` is keyed by `(artifact_key, review_revision)` and stores reviewer
principal/participant, timestamp, decision, optional reason, unique operation ID,
and normalized request data for duplicate-safe retries. Review revisions increase
monotonically per artifact; the latest event supplies current state. Updates are
forbidden; deletes are reserved for authorized backup replacement/project deletion.
The review event and its journal record commit together. Transfer guards include
the new table, and project exports include it in the semantic digest.

Blob lifecycle cleanup retains pointer and review rows, including legacy metadata.
Confirmed deletion clears inline content. Audit metadata grows with artifact and
review count until the project is explicitly destroyed or replaced from backup.

## Durable conversations (shared migration 31)

| Table | Durable responsibility |
|-------|------------------------|
| `rooms`, `room_members`, `threads` | Project conversation policy, membership and thread identity |
| `messages` | Immutable peer bodies/provenance, author operation hashes, room sequence and project-wide ordinal |
| `message_recipients` | Offline recipient snapshot, exact-binding targets, fetch/ack observations, expiry and wake suppression |
| `dispatch_outbox`, `dispatch_attempts` | Current publication generation, separate expiring relay lease and attempt recipient snapshots |
| `conversation_context`, `_conversation_state` | Server-held causal delivery context and cursor generation |

Publication and acknowledgement each use a single DO SQLite transaction. Message
bodies never enter the journal or relay status. Seven-day default expiry marks
recipient deliveries expired; it does not delete messages. Backup includes every
table. Restore clears active leases/context, rotates cursor generation and advances
agent epochs before releasing the project transfer lock. Embedded stores use the
same migration while public local-mode conversation operations remain unsupported.

### Work questions (#304, project migration 36)

| Table | Persisted content |
|---|---|
| `work_questions` | Question snapshot including context, revision, routing history, answer, discussion references and invalidation reason; indexed projections for task/attempt, requester, responder and state. |
| `question_receipts` | Canonical operation key/request and original question result, linked to the question; no time-based receipt eviction. |

Questions reference existing tasks and attempts. Mutable projections and the
snapshot change in one SQLite transaction with the receipt and journal event.
Attempt cancellation, completion and replacement invalidate affected questions
inside that same attempt transaction. Answer evidence is never overwritten.

Migration 36 is additive and shared by DO SQLite, Node and Bun embedded stores.
Backups declare `work-questions-v1` and include both tables. Older backups remain
readable; unsupported feature versions fail closed. Restore validates question
projections/correlation, retains decisions and discussion, and invalidates old
execution applicability before releasing the transfer lock.

### Work attempt history (#303, project migrations 38–40)

| Migration | Change |
|---|---|
| 38 | `queue_entries.enrolled_by_principal` and `enrolled_by_participant` record the assigner. Both are nullable; existing enrollments stay `NULL` and are treated as having no recorded assigner. |
| 39 | `work_attempts.revisions` holds JSON revision snapshots (`reserved`, `authorized`, `finished`); `NULL` for attempts recorded earlier. Index `work_attempts_owner(principal_id, participant_id, state)` serves owner-filtered recovery lists. |
| 40 | `attempt_corrections(id, attempt_id, task_id, reason, principal_id, participant_id, created_at)`, unique per attempt and task, links corrective work to a terminal attempt. A trigger keeps it append-only; another rejects changes to `state`, `outcome` or `finished_at` on terminal `work_attempts` rows. Backups declare `attempt-corrections-v1`. |

Migrations 38–40 are additive and shared by DO SQLite, Node and Bun embedded stores.
Transfer metadata and backups report the latest project migration instead of a
hard-coded number. Backups made before these migrations restore with `NULL`
assigners and revisions, and their semantic digest is computed without the new
columns.
