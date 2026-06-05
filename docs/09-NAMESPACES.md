# Namespace Convention — Shared-Project Coexistence

Two or more SDK consumers that share a single tila project can collide on declared
names: work-unit `type`, record `type`, artifact `kind`, and template
`name`/`template_name`.  `createNamespace` is a client-side convention that
prevents those collisions without any server-side change.

## The convention

```ts
import { createNamespace } from "@tila/sdk";

const ns = createNamespace(client, projectId, "cp");

await ns.tasks.create("t1", "task", {});
// Wire: POST /projects/<pid>/tasks  { type: "cp_task", ... }

const got = await ns.tasks.get("t1");
// got.entity.type === "task"  (prefix stripped on read)

await ns.records.create("config", { key: "db", value: {} });
// Wire: POST /projects/<pid>/records/cp_config  { ... }

await ns.artifacts.list({ kind: "report" });
// Wire: GET  /artifacts?kind=cp_report
// Returned pointers[].kind === "report"
```

`createNamespace(client, projectId, ns)` returns
`{ tasks, records, artifacts, templates }` — the four resource families whose
methods carry declared names.  Every other method on each family (relationships,
`download`, `readText`, etc.) is passed through unchanged.

## The joiner

The prefix character is **`_`** exclusively.  The resulting prefixed names
(`cp_task`, `myapp_deploy`) satisfy `RecordTypeSchema` (`/^[a-z][a-z0-9_-]*$/`).

## Double-prefix guard

`applyPrefix(ns, name)` throws a plain `Error` synchronously when `name` already
starts with `${ns}_`:

```
Namespace collision: "cp_task" already starts with prefix "cp_".
Call the raw factory if this name is intentional.
```

This prevents accidental double-prefixing before any network call is made.
`stripPrefix` is tolerant: it strips `${ns}_` if present and returns the name
unchanged if not — safe for mixed-namespace lists.

## Namespace validation

`createNamespace` validates the `ns` argument eagerly (at construction time,
before any method is callable).  `ns` must match `/^[a-z][a-z0-9_-]*$/` and
be non-empty; anything else throws `TypeError`.

## Namespace identity is immutable

A namespace prefix is a property of your **declared names** stored in the tila
project, not a runtime metadata tag.  Changing a namespace means renaming every
prefixed declared type/kind/name — that is a destructive schema operation with
no automated migration path.  Treat your namespace string as a permanent
identity, chosen once per consumer and never changed.

## What is prefixed

| Surface | Prefixed field | Strip on read |
|---|---|---|
| `tasks.create(id, type, data)` | `type` arg | `entity.type` |
| `tasks.get` / `tasks.update` | — | `entity.type` |
| `tasks.list({ type })` | `query.type` (if present) | `entities[].type` |
| `records.*` (all methods) | `type` arg (URL segment) | `record.type`; `items[].type` |
| `records.types()` / `typesInUse()` | — | each entry (tolerant) |
| `artifacts.upload` / `writeText` | `opts.kind` | **none** (response has no `kind`) |
| `artifacts.list({ kind })` | `query.kind` (if present) | `pointers[].kind` |
| `artifacts.search` / `grep` | `opts.kind` (if present) | `results[].kind` |
| `artifacts.getLatest(kind, resource)` | `kind` arg | bare `ArtifactPointer.kind` (null-guarded) |
| `templates.instantiate({ template_name })` | `template_name` | — |
| `templates.list()` | — | `templates[].name` AND `templates[].type` |

## What is never prefixed

- Relationship `type` (`tasks.addRelationship`, `artifacts.addRelationship`) —
  these are graph edge types, not declared names.  Prefixing them would corrupt
  the relationship graph (design OR-3).
- `resource` / `file:` resource strings (design OR-4).
- `mime_type`, entity/record/artifact ids, record keys, fencing tokens, slots.
- The `UnifiedSearchResult.type` discriminator (`"entity"`, `"artifact"`,
  `"record"`).

## Non-goals

- **No unified search namespacing.** `createNamespace` does not expose a
  `search` member.  Unified search returns results from all namespaces; partial
  stripping would be misleading.
- **No `ClaimHandle`/`withClaim` namespace-awareness.** `ClaimHandle` operates
  on entity IDs and fence tokens, neither of which is a declared name.  A claim
  acquired through the raw factory works unchanged alongside a namespaced
  consumer.
- **No `owner:<ns>` tags** — namespacing rides on declared-name prefixes only.
- **No namespace registry or migration tooling** — namespace identity is
  immutable (see above).

## Namespaces are not a security boundary

In tila v0.1, any project token can read and write declared names from any
namespace.  `createNamespace` is a **coexistence convention**, not an access
control mechanism.  Do not rely on it for isolation or multi-tenant security.

## Consumer hazards

### Deprecated factories are not namespace-aware

`createEntityMethods` and `createWorkUnitMethods` are deprecated aliases for
`createTaskMethods`.  They are **not** wrapped by `createNamespace` and bypass
the prefix/strip convention entirely.  Using them alongside a namespaced
consumer will cause bare unstripped names on the wire.

### Round-trip hazard with out-of-scope surfaces

A raw prefixed value read from an out-of-scope surface (unified search,
`ClaimHandle`) and fed back into a namespaced write will hit the double-prefix
throw.  For example:

```ts
const searchResult = await client.search({ q: "cp_task" });
// searchResult.results[0].type === "cp_task"   (not stripped — search is out of scope)

await ns.tasks.create("t2", "cp_task", {});
// throws: Namespace collision: "cp_task" already starts with prefix "cp_"
```

Strip the prefix manually before passing such a value back into the namespaced
API, or use the raw factory for that call.
