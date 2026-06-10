# tila-sdk

TypeScript SDK for [tila](https://github.com/davebream/tila) -- a state-and-coordination engine for multi-machine agentic work.

## Installation

```bash
npm install tila-sdk
```

`zod` is an optional peer dependency. Install it to enable opt-in response validation:

```bash
npm install zod
```

## Quick Start

```typescript
import { TilaClient, createEntityMethods } from "tila-sdk";

const client = new TilaClient({
  baseUrl: process.env.TILA_URL!,
  token: process.env.TILA_TOKEN!,
});

const projectId = "my-project";
const entities = createEntityMethods(client, projectId);

// Create an entity
const task = await entities.create("task-1", "task", {
  title: "Process dataset",
  status: "pending",
});

// Read it back
const detail = await entities.get("task-1");

// List entities by type
const list = await entities.list({ type: "task" });

// Update with new data
const updated = await entities.update("task-1", {
  status: "in-progress",
  assignee: "agent-7",
});

// Archive when done
await entities.archive("task-1");
```

### `createTila` — one facade, local or remote

`createTila(config, token?)` returns a uniform facade exposing the same resource
methods (`tasks`, `records`, `claims`, `artifacts`, `gates`, `signals`,
`journal`, `presence`, `schema`, `summary`, `search`, `templates`, `tokens`)
regardless of backend. Swap `config.backend` without changing any call site.

```typescript
import { createTila } from "tila-sdk";

// Cloudflare (HTTP) — token required
const tila = await createTila(
  { project_id: "my-project", backend: "cloudflare", worker_url: process.env.TILA_URL!, schema_version: 1, tila_version: "0", created_at: "" },
  process.env.TILA_TOKEN!,
);

// Local (in-process SQLite) — no token; requires the optional `better-sqlite3` peer dep
const local = await createTila({
  project_id: "my-project",
  backend: "local",
  local: { db_path: ".tila/project.db", artifacts_path: ".tila/artifacts" },
  schema_version: 1,
  tila_version: "0",
  created_at: "",
});

await tila.tasks.create("task-1", "task", { title: "uniform call site" });
await local.tasks.create("task-1", "task", { title: "uniform call site" });
local.close(); // closes the SQLite connection (no-op for cloudflare)
```

> **`better-sqlite3` peer dep:** the local backend lazily loads `better-sqlite3`
> (an optional peer dependency). Install it for local mode; cloudflare mode never
> touches it. Token issuance (`tila.tokens.*`) is HTTP-only and throws in local.

The `close()` method is the canonical lifecycle handle for both backends: it is a
no-op for cloudflare and closes the SQLite connection for local. It is safe to call
more than once (double-close safe).

In local mode, a few facade methods have no in-process equivalent and throw
`LocalUnsupportedError` instead of silently no-op'ing:

- `tokens.issue` / `tokens.revoke` / `tokens.list` (the D1 global token store is a
  Worker/Cloudflare concern).
- `artifacts.upload` and `artifacts.download` (binary R2 multipart upload/download —
  local consumers use the content-addressed text primitives `artifacts.writeText` /
  `artifacts.readText` instead).

### `tila-sdk/local` — direct local backend

For full control over the local stack (without the `createTila` facade), import the
heavy entry directly. It is a separate package export so the SQLite/`node:fs` stack
never loads from the main (zod-only) entry:

```typescript
import { createTilaLocal } from "tila-sdk/local";

const { project, artifacts, close } = await createTilaLocal({
  db_path: ".tila/project.db",       // SQLite file (created if absent)
  artifacts_path: ".tila/artifacts", // blob root directory
  project: "my-project",             // required — scopes artifact keys
  org: "my-org",                     // optional, defaults to "local"
});

// `project` is the full @tila/core backend surface (Entity/Coordination/Journal/
// Gate/Signal/Schema/Summary/Record); `artifacts` is the ArtifactBackend.
close(); // closes the underlying better-sqlite3 connection
```

> Note: the `createTilaLocal` option keys are `db_path`, `artifacts_path`, `org`,
> `project` (snake_case to mirror the `[local]` config section).

### `better-sqlite3` — optional peer dependency

`better-sqlite3` is an **optional peer dependency** with range **`>=11 <13`**. The
**tested / CI-exercised** version is **12.x (currently `12.10.0`)**; 11.x is declared
supported but is *not* exercised in CI. Install it only when you use the local
backend:

```bash
npm i better-sqlite3
```

If it (or its drizzle adapter) is missing, calling into the local backend throws
`MissingNativeDriverError` with the exact message:

```
tila-sdk/local requires the optional peer dependency 'better-sqlite3'. Run: npm i better-sqlite3
```

Importing `tila-sdk/local` never loads the native binary — only *calling*
`createTilaLocal` (or `createTila({ backend: "local" })`) does.

> **No prebuilt binaries for musl/Alpine or Windows-arm64.** `better-sqlite3` ships
> prebuilt binaries for common platforms but **not** musl-libc (Alpine) or
> Windows-arm64. On those, the consumer needs a build toolchain (Python + make + a C
> compiler) so `better-sqlite3` can compile from source on install.

> **`skipLibCheck: true` required** in your `tsconfig.json` when consuming
> `tila-sdk/local` types. The bundled `better-sqlite3` / `drizzle-orm` declarations
> do not fully round-trip through the dts rollup (a known rollup-dts limitation). This
> does **not** affect type-checking of *your own* code — `skipLibCheck` only skips
> re-checking library `.d.ts` internals (the ecosystem default, also used in this
> monorepo).

### Browser / HTTP-only consumers

The main `tila-sdk` entry stays zod-only — no native stack is statically reachable
from it (enforced by a bundle-hygiene test). Browsers and any HTTP-only environment
use the cloudflare backend; they never touch `better-sqlite3` or `node:fs`.

### Local-mode behavior divergences vs remote

Local mode presents the same facade shape, but a handful of methods diverge from the
HTTP backend. These are intentional and called out so consumers are not surprised:

| Method | Local behavior | Why |
|--------|----------------|-----|
| `schema.history` | Returns `[]` | Dead on **both** sides — the Worker exposes no schema-history route either, so the cloudflare branch would 404. (The data exists in `_schema_history`; it is simply not surfaced.) |
| `presence.listAll` | Returns only **active** machines (every row `active: true`) | The embedded backend's `listPresence()` already filters to active machines by TTL; remote additionally includes stale machines as `active: false`. |
| `artifacts.writeText` | Returns `deduplicated: false` and drops `tags` | The embedded artifacts table has no `tags` column, and the local write path does not report dedup. |
| `tasks.list` | Ignores `compact`, emits no pagination cursor | `compact` is an HTTP-only projection; the local list is non-paginated (no `next_cursor`/`total`). |
| `templates.list` | `variables` derived from `{{placeholders}}` | Local derives variables by scanning each template's entity data for `{{name}}` placeholders (`/\{\{(\w+)\}\}/`). |

### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | (required) | tila Worker URL |
| `token` | `string` | (required) | API token or session token |
| `validate` | `boolean` | `false` | Enable Zod response validation (requires `zod` installed) |
| `timeoutMs` | `number` | `30000` | Request timeout in milliseconds |

> **Note:** `validate` defaults to `false` to keep the bundle lightweight. Pass `validate: true` to enable Zod schema validation on every response (requires `zod` installed as a peer dependency).

If you have a `.tila/config.toml` project file:

```typescript
import { TilaClient } from "tila-sdk";

const client = TilaClient.fromConfig(config, process.env.TILA_TOKEN!);
```

## Claim Lifecycle

tila uses a first-writer-wins coordination model built on fencing tokens. The `withClaim` primitive acquires a resource lock, runs your callback, and releases the lock in `finally` -- preventing resource leaks.

Every `ClaimHandle` carries a monotonic `fence` number. Destructive writes (entity update, artifact upload) carry this fence automatically. The server rejects stale fences with error code `stale-fence`.

```typescript
import { TilaClient, withClaim } from "tila-sdk";

const client = new TilaClient({
  baseUrl: process.env.TILA_URL!,
  token: process.env.TILA_TOKEN!,
});

const projectId = "my-project";

await withClaim(client, projectId, "dataset/batch-42", "exclusive", 60_000, async (handle) => {
  // handle.fence is the monotonic fencing token
  // handle.expiresAt is the claim expiry (epoch ms)

  // Start heartbeat -- auto-renews at 40% of TTL (24s intervals for 60s TTL)
  const hb = handle.startHeartbeat(60_000);

  // Early-warning timer -- fires 5s before claim expires
  const expiry = handle.onClaimExpiring(5_000, () => {
    console.warn("Claim expiring soon -- wrap up!");
  });

  // Listen for heartbeat errors (409 = lost claim, 401 = auth expired)
  handle.on("error", (err) => {
    console.error("Heartbeat failed:", err.message);
  });

  try {
    // Fence-threaded entity update -- fence is carried automatically
    await handle.updateEntity("task-1", { status: "processing" });

    // ... do work ...

    await handle.updateEntity("task-1", { status: "complete" });
  } finally {
    expiry.stop();
    hb.stop();
  }
});
// Claim is released automatically when the callback exits
```

### Claim Modes

| Mode | Behavior |
|------|----------|
| `"exclusive"` | Only one holder at a time. Acquire fails if already held. |
| `"shared"` | Multiple holders allowed. Each gets a unique fence. |

## Artifacts

### Upload

**Inside a claim context (preferred):** The fence is threaded automatically.

```typescript
await withClaim(client, projectId, "output/report", "exclusive", 30_000, async (handle) => {
  const hb = handle.startHeartbeat(30_000);
  try {
    // Upload from a File or Blob
    const result = await handle.uploadArtifact(
      new Blob(["report content"], { type: "text/plain" }),
      { kind: "output" },
    );

    console.log(result.key);          // content-addressed key
    console.log(result.deduplicated);  // true if content already existed
  } finally {
    hb.stop();
  }
});
```

**Standalone upload (no claim):**

```typescript
import { createArtifactMethods } from "tila-sdk";

const artifacts = createArtifactMethods(client, projectId);

const result = await artifacts.upload(
  new Blob(["data"], { type: "application/json" }),
  { kind: "intermediate", mimeType: "application/json" },
);
```

**`mimeType` requirement:** When the file's `.type` property is empty (plain `Blob` with no type set), you must pass `mimeType` explicitly. A `TypeError` is thrown synchronously before any network request if `mimeType` is absent and `file.type` is empty.

### Download

`download()` returns a raw `ReadableStream`. The caller owns consumption and cleanup.

```typescript
const artifacts = createArtifactMethods(client, projectId);

const { body, contentType, contentLength } = await artifacts.download(
  "artifacts/task-1/abc123.json",
);

// Pipe to a file (Node.js)
const file = Bun.file("output.json");
await Bun.write(file, body);

// Or collect as text
const text = await new Response(body).text();
```

## Error Handling

### Typed Catch Pattern

Use `isTilaApiError()` (preferred over `instanceof` for cross-realm/bundled code):

```typescript
import { isTilaApiError, TILA_ERRORS } from "tila-sdk";

try {
  await entities.update("task-1", { status: "done" });
} catch (err) {
  if (isTilaApiError(err)) {
    switch (err.code) {
      case TILA_ERRORS.STALE_FENCE:
        // Fence was superseded -- re-acquire the claim
        break;
      case TILA_ERRORS.UNAUTHORIZED:
        // Token expired or invalid -- re-authenticate
        break;
      case TILA_ERRORS.NOT_FOUND:
        // Entity does not exist
        break;
      default:
        console.error(`API error ${err.status}: [${err.code}] ${err.message}`);
    }
  } else {
    // Network error, timeout, or malformed response
    console.error("Non-API error:", err);
  }
}
```

`TilaApiError` fields:

| Field | Type | Description |
|-------|------|-------------|
| `status` | `number` | HTTP status code |
| `code` | `string` | Machine-readable error code |
| `message` | `string` | Human-readable description |
| `retryable` | `boolean` | Whether the server considers this retryable |

### Error Code Conventions

tila uses two wire-format conventions for error codes:

- **Worker/auth layer:** `SCREAMING_SNAKE_CASE` -- e.g., `"UNAUTHORIZED"`, `"SESSION_EXPIRED"`, `"RATE_LIMITED"`
- **DO (Durable Object) layer:** `kebab-case` -- e.g., `"stale-fence"`, `"not-found"`, `"already-held"`

The `TILA_ERRORS` constant object normalizes both under typed keys so you never hardcode string literals:

```typescript
TILA_ERRORS.UNAUTHORIZED    // "UNAUTHORIZED"  (worker layer)
TILA_ERRORS.STALE_FENCE     // "stale-fence"   (DO layer)
TILA_ERRORS.NOT_FOUND       // "not-found"     (DO layer)
TILA_ERRORS.RATE_LIMITED    // "RATE_LIMITED"  (worker layer)
```

### Retry Wrapper

`withRetry` implements exponential backoff with full jitter (AWS pattern):

```typescript
import { withRetry, withClaim } from "tila-sdk";

const result = await withRetry(
  async () => {
    return await withClaim(client, projectId, "resource", "exclusive", 30_000, async (handle) => {
      const hb = handle.startHeartbeat(30_000);
      try {
        await handle.updateEntity("task-1", { status: "done" });
        return "success";
      } finally {
        hb.stop();
      }
    });
  },
  { maxRetries: 5, baseDelayMs: 200 },
);
```

**Hard stop rule:** A `TilaApiError` with `retryable === false` is never retried, regardless of `maxRetries`. Network errors and timeouts are always retried up to the limit.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRetries` | `number` | `3` | Maximum retry attempts after first failure |
| `baseDelayMs` | `number` | `200` | Base delay for exponential backoff |
| `maxDelayMs` | `number` | `30000` | Maximum delay cap |
| `jitter` | `boolean` | `true` | Apply full jitter to delay |

## API Reference

### Method Factories

`withClaim` + `ClaimHandle` is the recommended high-level coordination API. The method factories below are lower-level building blocks for advanced use -- e.g., when managing claim acquire/release manually.

| Factory | Primary Methods | Description |
|---------|----------------|-------------|
| `createEntityMethods(client, projectId)` | `create`, `get`, `list`, `update`, `archive`, `addRelationship`, `addArtifactRef`, `listArtifactRefs` | Entity CRUD and relationships |
| `createClaimMethods(client, projectId)` | `acquire`, `renew`, `release`, `list`, `get` | Low-level claim management |
| `createArtifactMethods(client, projectId)` | `upload`, `download`, `list`, `search`, `addRelationship`, `listRelationships` | Artifact storage and search |
| `createPresenceMethods(client, projectId)` | `heartbeat`, `list`, `listAll` | Machine presence tracking |
| `createSignalMethods(client, projectId)` | `inbox`, `send`, `ack` | Inter-machine signaling |
| `createGateMethods(client, projectId)` | `list`, `create`, `resolve`, `remove` | Coordination gates |
| `createTemplateMethods(client, projectId)` | `instantiate` | Entity template instantiation |
| `createSummaryMethods(client, projectId)` | `get` | Project summary |
| `createJournalMethods(client, projectId)` | `query` | Event journal queries |
| `createSchemaMethods(client, projectId)` | `get`, `apply`, `history` | Schema-as-config management |
| `createTokenMethods(client)` | `issue`, `revoke`, `list` | API token management (no `projectId`) |

### GitHub Token Exchange

For CI environments (GitHub Actions) where a tila API token is not available:

```typescript
import { exchangeGitHubToken, TilaClient } from "tila-sdk";

const { sessionToken, expiresAt, permission } = await exchangeGitHubToken(
  process.env.TILA_URL!,
  "my-project",
  process.env.GITHUB_TOKEN!,
);

const client = new TilaClient({
  baseUrl: process.env.TILA_URL!,
  token: sessionToken,
});
// sessionToken is short-lived -- expiresAt is epoch ms
```

> **Note:** `exchangeGitHubToken` is a standalone function, not a `TilaClient` method. The repository must be registered via `tila init --github` before tokens can be exchanged.

## License

See the repository root for license information.
