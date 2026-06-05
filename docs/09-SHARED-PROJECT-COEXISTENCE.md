# Shared-Project Coexistence

Can a framework built on the tila SDK and direct tila use share one project? Yes, by
default. Namespaces are a *convention*, not an enforced boundary — the Durable Object is
the only isolation unit in v0.1, and every consumer sharing a project token shares that
isolation unit. This guide explains which conventions make coexistence work well, where
the limits are, and when to reach for a separate project instead.

## Decision rule: shared vs separate

**Default: shared project, partitioned by convention.**

Use one project and rely on type-prefix namespacing (see
[Conventions that work today](#conventions-that-work-today)). This is sufficient for
the vast majority of cases: internal frameworks, multi-agent pipelines, shared team
tooling, and framework SDK wrappers on the same project.

**Choose a separate project only when there is a trust or regulatory boundary you
cannot bridge.**

| Signal | Recommendation |
|---|---|
| Framework is multi-tenant / distributed to untrusted third parties | **Separate projects** |
| Regulatory requirement for hard data isolation | **Separate projects** |
| Framework team and direct consumers are the same team | **Shared project** |
| Internal framework on the same infrastructure | **Shared project** |
| Framework and direct consumers need the same journal/presence stream | **Shared project** |
| Different teams, same trust domain | **Shared project** (filter by type prefix on the read side) |

The most important constraint to understand: **tila has no per-namespace authorization in
v0.1.** Any holder of a write-scoped token can read and write every namespace in the
project. If you need to prevent a framework consumer from reading or writing another
consumer's records and work units, separate projects are the only option today.

## Conventions that work today

### Work-unit type prefixing

Declare work-unit types per namespace in `tila.schema.toml`. Type is the structural
partition: it is a declared taxonomy axis validated at write time — writes to an
undeclared type are rejected with `422 constraint-violation`. Every resource name leads with
the type (`type:id` grammar), so the type prefix is visible in fences, journal events,
relationships, and claim resources.

Type regex: `^[a-z][a-z0-9_-]*$` — lowercase, starts with a letter, no colon, no slash.

```toml
# tila.schema.toml

# Framework namespace
[work_units.cp_task]
description = "Control plane task managed by the framework"

[work_units.cp_pipeline]
description = "Ordered execution pipeline owned by the framework"

# Direct-use namespace
[work_units.infra_job]
description = "Infrastructure job submitted by operators directly"
```

```toml
# tila.schema.toml — records follow the same pattern

[records.cp_config]
format = "yaml"
history = "snapshot"
key_description = "config variant name"

[records.infra_manifest]
format = "json"
history = "revision"
```

With this layout, every `cp_*` work unit and record belongs to the framework namespace,
and every `infra_*` work unit and record belongs to the direct-use namespace. The type
prefix is enforced at write — no coordination overhead, no runtime dispatch.

### Record owner tags

Tags are **optional and additive**. The structural partition is the type prefix; tags
carry cross-cutting facets like `repo:*`, `team:*`, or `owner:<ns>` that do not belong
in identity.

Tag regex: `^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,63}$` — note that `:` is **allowed** in tags,
which is what makes `owner:<ns>` valid. Tags are lowercased and deduplicated at write,
so `owner:cp` and `Owner:CP` both normalize to `owner:cp`. A record may have at most
20 tags.

```bash
# Tag a record as belonging to the control-plane namespace
tila record set cp_config prod ./config.yaml --tag owner:cp --tag repo:control-plane

# List all records owned by the direct-use namespace
tila record list infra_manifest --tag owner:infra
```

Use `owner:<ns>` when you need a cross-cutting ownership facet — for example, to query
all records across multiple types that belong to one namespace. The type prefix alone is
sufficient for single-type queries.

### Signal target routing

Route coordination signals to a namespace by convention in the signal `target` string.
The `target` field is a plain string (`z.string().min(1)`); tila does not parse or
validate it beyond non-empty. Use a consistent naming convention so consumers can
filter by prefix:

```bash
# Framework sends a signal targeting the control-plane scheduler
tila signal send --target "cp:scheduler" --type "work-ready" --body '{"taskId":"cp_task/T-42"}'

# Direct-use tooling signals the infra pipeline
tila signal send --target "infra:deploy-gate" --type "approval-granted" --body '{}'
```

Consumers subscribe to the project-level signal stream and filter by the `target` prefix
on the read side.

## Why the namespace lives in the type

Three approaches were considered for embedding a namespace identifier. Two were rejected.

| Where | Verdict | Reason |
|---|---|---|
| In the **type** (`cp_task`, `pipeline_config`) | ✅ chosen | Type is a *declared taxonomy axis*; it is the first segment of the `type:id` resource grammar; collisions are caught at write (unregistered type rejected with `422 constraint-violation`); discriminates work units, records, and artifact kinds uniformly. |
| In the **key** (`cp:T-1`, `infra:job-7`) | ❌ rejected | `:` is the reserved resource delimiter in the `type:id` grammar. Record keys **forbid colon** by validation (`packages/schemas/src/record.ts:74-79`). Work-unit ids "work" by opaque-id luck but weaken the `type:id` resource grammar and couple namespace to identity. |
| A `(type, namespace, key)` **identity column** | ❌ rejected | Verbatim the `(type, scope, key)` pattern locked out in [Records — Why Scope Is Not In The Primary Key](08-RECORDS.md). Identity changes are destructive for fences, journal events, and references. Tags are additive; primary-key changes are not. |

The one weakness of type-prefix namespacing: **namespace identity must be stable.**
Renaming or detaching a namespace means renaming its declared types, which rewrites
fences, journal events, and resource references. See
[The destructive-detach gotcha](#the-destructive-detach-gotcha).

## The four irreducible leaks

A tila project is one coordination space. No matter how carefully you prefix types, some
primitives are project-global and cannot be partitioned by convention.

### Project-wide search (FTS)

The FTS5 index covers the entire project. A full-text search query hits work units,
records, and artifacts from every namespace — there is no per-type or per-tag FTS
scope in v0.1.

**Mitigation:** filter search results by type prefix on the read side. If your search
call returns `cp_task` and `infra_job` results, discard the results that do not match
your namespace's type prefix.

### Shared-file claim contention

Claims keyed by `file:` path are project-global. Two namespaces that claim the same
`file:` path contend — the second claimer gets a stale-fence rejection under
first-writer-wins semantics with DO serialization. There is no per-namespace claim
scope.

**Mitigation:** use a namespace-qualified path convention: `file:cp/path/to/file` vs
`file:infra/path/to/file`. Since the `file:` target is a convention-based string, the
prefix is free to choose and costs nothing.

### Cross-namespace relationships

The relationship table does not enforce type-prefix boundaries. A work unit in the `cp_*`
namespace can be linked to a work unit in the `infra_*` namespace — tila will create the
relationship without complaint. This is sometimes desirable (a framework task blocking a
direct-use job), but it means relationships alone cannot enforce namespace isolation.

**Mitigation:** if you need a strict namespace boundary, audit relationships on the read
side by checking the type prefixes of both endpoints.

### Project-global journal and presence

The journal stream and the presence/heartbeat stream are project-wide. Subscribers see
all namespaces' journal events and all machines' heartbeats, regardless of which
namespace emitted them.

**Mitigation:** filter journal events by the `type` field of the referenced work unit or
record. Filter presence entries by machine name convention (e.g. machines owned by the
framework could use a `cp-` name prefix).

## The destructive-detach gotcha

Detaching a namespace means removing its declared types from `tila.schema.toml`. When
the schema is applied, tila classifies the removal as a `work-unit-removed` schema
change — a **destructive schema operation** that carries the count of affected rows
(`entityCount`). The work units of the removed type still exist in the database; their
type reference is now orphaned from the declared schema, and fences, journal events, and
resource names that embed the type string become stale relative to any future renamed
type.

In short: **a namespace rename is not free.** It is not a metadata change. Removing or
renaming a declared type touches fences, journal entries, and every resource reference
that uses `type:id` grammar.

Plan namespace boundaries up front. Treat namespace identity as stable — the type prefix
you choose at project setup should be the type prefix you keep for the lifetime of the
project. If you must rename, treat it as a schema migration: audit the affected row
count, archive or migrate records and work units to the new type, and verify references
before removing the old type declaration.

## See also

- [Records](08-RECORDS.md): typed mutable records — identity, key/tag validation, resource grammar, and the `(type, scope, key)` lockout
- [Settled Decisions](01-DECISIONS.md): first-writer-wins fencing model
- [Search](06-SEARCH.md): FTS scope and reindex behavior
