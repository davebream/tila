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
import { createTila } from "tila-sdk";

const tila = await createTila(
  {
    project_id: "my-project",
    backend: "cloudflare",
    worker_url: process.env.TILA_URL!,
    schema_version: 1,
    tila_version: "0",
    created_at: "",
  },
  process.env.TILA_TOKEN!,
);

// Create a task
const task = await tila.tasks.create("task-1", "task", {
  title: "Process dataset",
  status: "pending",
});

// Read it back
const detail = await tila.tasks.get("task-1");

// List tasks by type
const list = await tila.tasks.list({ type: "task" });

// Update with new data
const updated = await tila.tasks.update("task-1", {
  status: "in-progress",
  assignee: "agent-7",
});

// Archive when done
await tila.tasks.archive("task-1");
```

### Refreshable credentials

`TilaClient`, `TilaClient.fromConfig`, and the remote branch of `createTila`
accept either a static token string or an async `TokenProvider`. Static strings
and the legacy two-argument `dpopSigner` remain supported throughout the current
`0.x` transition; removal requires a separately announced breaking release.

```typescript
import { TilaClient, createExternalTokenProvider } from "tila-sdk";

const client = new TilaClient({
  baseUrl: process.env.TILA_URL!,
  token: createExternalTokenProvider(async (context) => {
    // Application code owns login, storage, and customer selection.
    const credential = await customerCredentials.load({
      signal: context.signal,
      forceRefresh: context.reason === "authentication",
      previous: context.previousCredential?.refreshMetadata,
    });
    return {
      token: credential.accessToken, // A Tila credential, not an upstream ID token.
      tokenType: "Bearer",
      expiresAt: credential.expiresAt, // Unix seconds, not milliseconds.
      refreshMetadata: credential.refreshState,
    };
  }),
  expirySkewMs: 30_000,
  timeoutMs: 30_000,
});

await client.get("/projects/my-project/tasks", { signal: abortController.signal });
```

The application objects `customerCredentials` and `abortController` in this
example are supplied by the caller. `createServiceTokenProvider` accepts a static
string, a `TokenCredential`, or a callback with the same contract. The external
adapter accepts a callback. Neither helper issues or rotates service keys, stores
secrets, or runs a customer OAuth flow.

| Behavior | Contract |
|---|---|
| Provider context | Request `method` and absolute `url`, acquisition `signal`, `reason`, optional `previousCredential` and `authenticationError`. |
| Refresh reason | `initial`, `expiry`, `request` (unknown expiry), or `authentication`. The initiating request supplies context for shared acquisition. |
| Cache | Per client, reusable until `expiresAt` minus `expirySkewMs` (default 30 seconds). No cross-client/customer cache. |
| Unknown/near expiry | No expiry means acquire again on the next request. A newly acquired token inside the skew window serves current waiters but is not reused for later requests. Already expired tokens are rejected. |
| Concurrency | Concurrent acquisition/refresh shares one provider call. A late 401 cannot invalidate a newer credential generation. |

Use one client per customer/credential identity; providers must not select a
different customer based on the request URL. Do not mutate returned credentials
or their refresh metadata after returning them. Only `Bearer` is supported as
`tokenType`; DPoP-bound Tila credentials also use this scheme.

Every low-level client method accepts `signal`. The request deadline starts before
credential acquisition and covers signing, HTTP, one authentication retry, and
JSON body consumption. A caller can stop waiting even if its provider ignores
cancellation. Cancelling one waiter leaves other waiters running; when all leave,
the shared acquisition is aborted and late results are discarded. Raw-response
streams returned by `requestRaw` are caller-owned after headers arrive.

Provider clients retry once for HTTP 401 with `unauthorized` or `session-expired`,
using refreshed credentials and the same body and idempotency key. Other auth
errors, network failures, and static credentials do not trigger this retry.
`withRetry` is a separate, opt-in retry policy; it honors non-retryable
`TokenProviderError`/`TilaApiError` and supports a cancellation `signal` for attempts
and backoff. Pass the same signal to requests when using a custom abort reason.

Application-thrown errors retain their identity and fields. SDK provider failures
use `TokenProviderError` (`code`, `retryable`, optional `cause`); exchange API
failures use `TilaApiError` (`status`, typed `code`, `retryable`). The SDK does not
log credentials, proofs, assertions, or refresh metadata. Application errors and
causes may contain application-supplied secrets: select safe fields when logging.

### OIDC workload credentials

Configure a scoped `oidc` workload binding to a Tila service principal first.
The deployment must already have its OIDC issuer/audience configured. The helper
uses the existing generic exchange endpoint and rejects legacy human-session
responses, missing service lineage, and mismatched projects.

```typescript
import { createTila, createOidcWorkloadTokenProvider } from "tila-sdk";

const provider = createOidcWorkloadTokenProvider({
  baseUrl: process.env.TILA_URL!,
  projectId: "my-project",
  // Your workload platform supplies a fresh assertion for every call.
  getAssertion: ({ signal }) => workloadIdentity.getFreshAssertion({ signal }),
});
const tila = await createTila(config, provider);
```

`workloadIdentity` and `config` are application-owned. Each assertion exchanges
once; renewal needs a new assertion. Exchange is never automatically replayed,
including after ambiguous network failure. `workload-already-exchanged` and
`workload-revoked` remain typed API errors. Credentials and exchange requests are
restricted to the configured deployment origin, and automatic HTTP redirects are
disabled so proofs remain bound to the intended request.

### DPoP with providers

A provider credential can include `dpop: { jkt, signProof }`. The workload helper
accepts the same binding and sends `jkt` during exchange. `signProof` receives
`{ htm, htu, accessToken, ath, signal }`. Use the supplied values in a fresh ES256
JWT, with a public JWK header, `typ: "dpop+jwt"`, current Unix-second `iat`, and a
new `jti`. The `htu` is canonicalized without query/fragment; `ath` is the
base64url SHA-256 of the exact token sent in `Authorization`.

The SDK checks the returned proof's request/token/key binding before sending it.
The Worker verifies its signature and checks `ath` when present, while accepting
existing proofs without `ath` during the compatibility transition. This is a
compatibility profile, not mandatory RFC 9449 enforcement for legacy clients.
Provider credentials must carry their own signer; combining a provider with the
legacy top-level `dpopSigner` is rejected. Generated `Authorization` and `DPoP`
headers take precedence over all case variants in `extraHeaders`.

### `createTila` — one facade, local or remote

`createTila(config, token?)` returns a uniform facade exposing the same resource
methods (`tasks`, `records`, `claims`, `artifacts`, `gates`, `signals`,
`journal`, `presence`, `schema`, `summary`, `search`, `templates`, `tokens`)
regardless of backend. Swap `config.backend` without changing any call site.

Each facade/client generates one UUID `participant_id` and reuses it for its lifetime. Pass an explicit participant ID when separate instances must continue the same lease; environment fields are optional metadata and never affect authorization:

```typescript
const tila = await createTila(config, token, {
  participantId: process.env.TILA_PARTICIPANT_ID,
  environment: { machine: "runner-7", repository: "org/repo" },
});
```

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
  dbPath: ".tila/project.db",        // SQLite file (created if absent)
  artifactsPath: ".tila/artifacts",  // blob root directory
  project: "my-project",             // required — scopes artifact keys
  org: "my-org",                     // optional, defaults to "local"
});

// `project` is the full @tila/core backend surface (Entity/Coordination/Journal/
// Gate/Signal/Schema/Summary/Record); `artifacts` is the ArtifactBackend.
close(); // closes the underlying better-sqlite3 connection
```

> Note: the `createTilaLocal` option keys are camelCase — `dbPath`, `artifactsPath`,
> `org`, `project`. (The `createTila` facade's `config.local` section uses snake_case
> `db_path` / `artifacts_path` to mirror the `[local]` config file; the direct
> `createTilaLocal` options object is camelCase.)

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
| `presence.listAll` | Returns only **active** participants (every row `active: true`) | The embedded backend's `listPresence()` already filters to active participants by TTL; remote additionally includes stale participants as `active: false`. |
| `tasks.list` | Ignores `compact`, emits no pagination cursor | `compact` is an HTTP-only projection; the local list is non-paginated (no `next_cursor`/`total`). |
| `templates.list` | `variables` derived from `{{placeholders}}` | Local derives variables by scanning each template's entity data for `{{name}}` placeholders (`/\{\{(\w+)\}\}/`). |
| Generic `idempotency_key` (e.g. on `claims.acquire`) | Accepted but **not honored** | Generic local request deduplication is not wired; a retried entity create can fail on its existing primary key. This does not apply to versioned artifact operations, which persist their own retry receipts using `idempotencyKey`. |

Local `artifacts.writeText()` preserves tags and reports content deduplication.
Explicit artifact revisions share history, metadata, restore, and operation-retry
semantics with the remote backend. See [Revision history and restore](#revision-history-and-restore).

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
| `"exclusive"` | Only one participant at a time. A different participant conflicts, even under the same principal. |
| `"owner"` | One principal at a time. A new participant under that principal transfers ownership and bumps the fence. |

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

### Revision history and restore

Versioning is opt-in. Supply `lineageId` and a live `lineageFence` when writing;
claim the canonical resource `artifact:<lineageId>`. A lineage keeps one kind and
resource for its lifetime. Writes without lineage options keep their existing
content-addressed behavior. If a versioned write also names an entity `resource`,
acquire that entity's claim separately and pass its `fence` as well.

This example assumes the project exists, the token has write access, and the
project schema permits the `report` artifact kind. It writes two revisions,
pages through their metadata, then restores the first revision as a new head:

```typescript
import { TilaClient, createArtifactMethods, withClaim } from "tila-sdk";

const client = new TilaClient({
  baseUrl: process.env.TILA_URL!,
  token: process.env.TILA_TOKEN!,
});
const projectId = "my-project";
const lineageId = "release-report";
const artifacts = createArtifactMethods(client, projectId);
const operationId = crypto.randomUUID(); // Persist this if retries span restarts.

await withClaim(client, projectId, `artifact:${lineageId}`, "exclusive", 60_000, async (claim) => {
  const heartbeat = claim.startHeartbeat(60_000);
  try {
    const writeOptions = {
      kind: "report",
      lineageId,
      lineageFence: claim.fence,
    };
    const first = await artifacts.writeText("# Initial report", {
      ...writeOptions,
      tags: ["draft"],
      idempotencyKey: `${operationId}:first`,
    });
    await artifacts.writeText("# Updated report", {
      ...writeOptions,
      tags: ["reviewed"],
      idempotencyKey: `${operationId}:second`,
    });

    let page = await artifacts.history(first.key, { limit: 1 });
    for (;;) {
      console.log(page.items); // Newest first; metadata only.
      if (page.meta.next_cursor === null) break;
      page = await artifacts.history(first.key, {
        limit: 1,
        cursor: page.meta.next_cursor,
      });
    }

    const restored = await artifacts.restore(first.key, {
      fence: claim.fence,
      idempotencyKey: `${operationId}:restore`,
    });
    const { pointer } = await artifacts.meta(restored.key);
    console.log(pointer.revision, pointer.restored_from, pointer.tags);
    console.log((await artifacts.readText(restored.key)).content);
  } finally {
    heartbeat.stop();
  }
}); // withClaim releases the lineage claim even if the callback throws.
```

| Operation | Contract |
|---|---|
| `history(key, { limit?, cursor? })` | Accepts any revision key in the lineage. Returns `items` and `meta` (`total`, `limit`, `next_cursor`). Default limit is 20, clamped to 1–200. Cursors are lineage-bound and retain the initial revision ceiling, so new writes do not shift later pages. Restart without a cursor to see newer writes. |
| `meta(key)` | Returns `{ ok: true, pointer }` without reading blob contents. The pointer includes lineage, revision, tags, restore origin, and deletion state. |
| `restore(key, { fence, lineage_id?, tags?, idempotencyKey? })` | Appends a new revision with its own key, even when the bytes match the current head. `restored_from` records the source key. Omitted tags inherit the source; `tags: []` clears tags only on the new revision. |
| Reading a specific version | Use a history item's `r2_key` with `download()` or `readText()`. Ordinary identical-content uploads may deduplicate to an earlier revision without moving the head; use `restore()` to record a head change. |

Tags on versioned artifacts are assigned at write/restore time; there is no
revision tag-edit endpoint. Restoring a legacy artifact requires a new explicit
`lineage_id`; it creates revision 1 without rewriting the source or inferring
history from old supersedes links.

Use a distinct `idempotencyKey` per logical write or restore, and reuse that key
with the same request when retrying an uncertain response. Reusing it with
different input is rejected. An accepted operation can finish publication after
its lease expires; a new operation needs a live claim. Persist both the retry key
and request if recovery must survive a client restart. These revision receipts
also work in the Node/Bun embedded backends; they do not imply generic local
request idempotency.

Retention is opt-in per artifact kind; zero or omitted `retention_days` keeps
content indefinitely. Each restore gets its own production time and current
retention policy, and the live head is protected from automatic sweep. Deleted
revisions remain available through history/meta with `tombstoned_at` and
`blob_deleted_at` state; remote downloads/restores return HTTP 410
`artifact-unavailable` once content is unavailable. Embedded operations report
the same error code. An unknown key returns not-found instead. See the
[lifecycle operations guide](../../docs/05-OPERATIONS.md#versioned-artifact-lifecycle)
for deletion and recovery details.

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

All HTTP `error.code` values use **kebab-case** (`^[a-z][a-z0-9-]*$`), e.g. `"unauthorized"`, `"stale-fence"`, `"validation-error"`.

The `TILA_ERRORS` constant object maps typed keys to exact wire strings so you never hardcode literals:

```typescript
TILA_ERRORS.UNAUTHORIZED    // "unauthorized"
TILA_ERRORS.STALE_FENCE     // "stale-fence"
TILA_ERRORS.NOT_FOUND       // "not-found"
TILA_ERRORS.RATE_LIMITED    // "rate-limited"
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
| `createArtifactMethods(client, projectId)` | `upload`, `writeText`, `download`, `readText`, `list`, `search`, `history`, `meta`, `restore`, `addRelationship`, `listRelationships` | Artifact storage, search, and revision history |
| `createPresenceMethods(client, projectId)` | `heartbeat`, `list`, `listAll` | Machine presence tracking |
| `createSignalMethods(client, projectId)` | `inbox`, `send`, `ack` | Inter-machine signaling |
| `createGateMethods(client, projectId)` | `list`, `create`, `resolve`, `remove` | Coordination gates |
| `createTemplateMethods(client, projectId)` | `instantiate` | Entity template instantiation |
| `createSummaryMethods(client, projectId)` | `get` | Project summary |
| `createJournalMethods(client, projectId)` | `query`, `replay`, `getCursor`, `acknowledge` | Journal queries and durable replay |
| `createHandoffMethods(client, projectId)` | `create`, `get`, `list` | Immutable session handoffs |
| `createReentryMethod(client, projectId)` | callable | Recover project context in one workflow |
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


### Durable cursors and handoffs

Cloud and local facades expose `reentry`, `handoffs`, and journal continuity methods.
Configure the same authenticated principal and stable participant ID to resume a
cursor on another runtime. A different participant can consume a handoff without
inheriting its creator's cursor or claims.

```ts
const state = await tila.reentry({ resource: "task:T-1", limit: 100 });
// Process state.summary, state.active_claims, state.pending_signals,
// state.handoff, and state.changes.events before acknowledging.
await tila.journal.acknowledge({ seq: state.changes.next_after_seq });
let page = state.changes;
while (page.has_more) {
  page = await tila.journal.replay({
    after_seq: page.next_after_seq,
    through_seq: page.through_seq,
  });
  // Process page.events before acknowledging.
  await tila.journal.acknowledge({ seq: page.next_after_seq });
}
const handoff = await tila.handoffs.create({
  id: crypto.randomUUID(), // Persist and reuse this ID if retrying after a crash.
  summary: "Implementation ready for verification",
  current_state: { phase: "verification" },
  findings: ["Cloud and local schemas match"],
  unresolved_questions: [],
  based_on_seq: page.through_seq,
  references: [{ type: "task", id: "T-1" }],
});
```

Replay is oldest-first with a fixed `through_seq`, a default page size of 100,
and a maximum of 200. `journal.query()` retains its existing behavior. Replay
includes archived history; missing or unreadable history fails explicitly.
`getCursor()` and `acknowledge()` return `{ ok, cursor: { seq, updated_at } }`.
Acknowledgements never move backwards, reject future positions, and survive
presence expiry. Reads do not automatically acknowledge signals or journal events.

Re-entry chooses its starting sequence from explicit `after_seq`, then an existing
saved cursor (including zero), then the selected handoff's `based_on_seq`, then zero.
Select a handoff with `handoff_id` or `resource`, never both. Without a selector,
the caller participant's latest handoff is used. A resource searches across project
participants using `task:<id>`, `record:<type>:<key>`, `artifact:<key>`, or a claim's
exact resource; it does not filter replay events. Handoff lists are newest-first,
with `next_before_seq` passed as `before_seq` for the next page.

Handoffs are immutable; save a new handoff with `supersedes_id` for corrections.
The SDK generates an ID if omitted, but supply and persist an ID for retries across
process restarts. Creation returns `{ ok, handoff }`; repeating the same ID, creator,
and content returns the original snapshot. Referenced objects are not pinned, and
historical claim snapshots never grant current write authority. Continuity state has
no automatic expiry and is included in project backups.

## Durable conversations

Cloudflare facades expose `conversations`, `inbox` and `dispatch`. Local facades
expose the same methods but reject them with `unsupported-capability`. Agent run
pins and explicit enrollment capabilities are required to consume an inbox.

```typescript
const sent = await tila.conversations.publish("coordination", {
  client_op_id: "review-request-1", // Preserve across retries.
  body: "Please inspect the deployment",
  targets: [{ kind: "agent", agent_id: "worker" }],
  reply_expected: true,
});
const page = await tila.inbox.fetch("worker");
for (const item of page.deliveries) {
  await tila.inbox.ack("worker", item.delivery.id, {
    ...page.binding,
    disposition: "accepted",
  });
  // Process peer content only after accepting responsibility.
}
```

History and inbox cursors are independent. An expired inbox page cursor returns a
fresh pending page with `cursor_error`; an expired history cursor throws
`cursor-expired`. Replies reuse the supplied `reply_op_id`. Acknowledgement records
accepted processing or decline, never task completion. Inline bodies are limited
to 64 KB UTF-8; `artifact_refs` accepts existing artifact keys.

Relay runs can only use dispatch and attachment authority. `dispatch.status(agent,
leaseToken)` reconciles a particular wake using metadata, including subsequent
fetch/ack observations. It never returns bodies or stamps deliveries as fetched.
`dispatch.lease` and `dispatch.report` require the current binding and enrollment;
old reports cannot quiet newer publications. Native wake transport is a separate
host-connector integration.
