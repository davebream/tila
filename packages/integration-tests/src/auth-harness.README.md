# Auth Test Harness — `@tila/worker/test-support`

This document describes the shared auth test harness consumed by `packages/integration-tests/src/auth-*.test.ts` and available to sibling WI builders.

---

## Harness API

### `makeAuthEnv(overrides?: Partial<Env>): Env`

Returns a static `Env` suitable for passing to `app.fetch()` in tests. Includes:

- `GITHUB_SESSION_HMAC_KEY`: a test-only base64url HMAC key (do not use in production)
- `PROJECT`: a Durable Object namespace stub with `idFromName`/`get` that returns a stub DO whose `fetch` resolves to `{ ok: true }`
- `DB`, `ARTIFACTS`, `ANALYTICS`: placeholder stubs

Use `overrides` to swap in a wrong HMAC key for signature-forgery negative tests:

```ts
const wrongKeyEnv = makeAuthEnv({ GITHUB_SESSION_HMAC_KEY: "d3Jvbmcta2V5" });
// Present a token signed with TEST_HMAC_KEY to this env → 401 unauthorized (signature mismatch)
const res = await app.fetch(req, wrongKeyEnv, execCtx);
```

### `createAuthTestApp(env: Env, opts?: { mountProjectRoute?: boolean; rateLimitStore?: RateLimitStoreInterface }): Hono`

Constructs a minimal Hono app wired with:
- `createAuthMiddleware()` (session + D1 token auth)
- Auth routes: `POST /api/auth/github/exchange`, `GET /auth/session/status`, `POST /auth/session/revoke`
- Token routes: `POST /tokens`, `DELETE /tokens/:id`

When `opts.mountProjectRoute` is `true`, also mounts:
- `projectMiddleware` on `/projects/:projectId`
- A stub `GET /projects/:projectId/_probe` route

The project-route mount uses the same prefix as production (`/projects/:projectId` at index.ts:198), NOT `/api/projects`. Use `mountProjectRoute: true` when testing project-mismatch rejection.

```ts
// Bare auth (default)
const app = createAuthTestApp(env);

// With project route (for project-mismatch test)
const app = createAuthTestApp(env, { mountProjectRoute: true });
const res = await app.fetch(
  new Request("http://localhost/projects/other-project/_probe", {
    headers: { Authorization: `Bearer ${tokenScopedToProjectA}` },
  }),
  env,
  execCtx,
);
// → 403 project-mismatch
```

### `authFixtures`

A namespace of credential builders and deferred stubs.

#### `authFixtures.mintSessionToken(overrides?: Record<string, unknown>): Promise<string>`

Mints a valid `tila_s.<jwt>` session token signed with `TEST_HMAC_KEY`.

Pass `overrides` to produce invalid payloads for negative tests:

```ts
// Expired token
const expired = await authFixtures.mintSessionToken({ expires_at: Math.floor(Date.now() / 1000) - 10 });

// Wrong project
const wrongProject = await authFixtures.mintSessionToken({ project_id: "other-project" });

// Token with a specific jti (for revocation tests)
const withJti = await authFixtures.mintSessionToken({ jti: "my-jti-value" });
```

For **signature-forgery** negative tests, do NOT add a second arg. Instead, call `app.fetch` with a wrong-key `Env` (see `makeAuthEnv` above).

#### `authFixtures.mintD1Token(): string`

Returns a deterministic plaintext D1 bearer token for testing (not cryptographically random).

#### `authFixtures.hashToken(plaintext: string): Promise<string>`

SHA-256 hex digest of a plaintext token (no pepper). Matches the worker's bare-SHA-256 fallback.

#### `authFixtures.mintOidcJwt(opts)` — DEFERRED STUB

Throws `"mintOidcJwt: shape TBD — owned by WI-B1"`. Implement when WI-B1 (#124) lands and pins the claim contract.

#### `authFixtures.buildDpopProof(opts)` — DEFERRED STUB

Throws `"buildDpopProof: shape TBD — owned by WI-G"`. Implement when WI-G (#130) lands and pins the JWK-thumbprint/htu/htm contract.

#### `authFixtures.instanceBinding(opts)` — DEFERRED STUB

Throws `"instanceBinding: shape TBD — owned by WI-A/WI-E"`. Implement when WI-A (#123) / WI-E (#128) land and pin the binding-claim contract.

### `featurePending(wi: string, issueNumber: number | string, reason: string)`

Returns a `{ describe, it }` pair whose blocks are skip-gated (`describe.skip` / `it.skip`) and automatically prefix every title with `FEATURE-PENDING(WI-x, #issue): <reason> — `.

```ts
const fp = featurePending("WI-C", 126, "bulk kill-switch / subject-level revocation");

fp.describe("subject-level bulk revocation", () => {
  fp.it("revoking a principal rejects all its in-flight tokens within 60s", async () => {
    // real body here — skipped so it never runs
    throw new Error("shape TBD — owned by WI-C");
  });
});
```

The greppable marker is injected automatically — callers should NOT embed `FEATURE-PENDING(...)` in the title string manually.

### `_resetMiddlewareStateForTest(): void`

Resets the worker's per-isolate state between tests:
- Clears the jti revocation cache (populated by `revokeJtiInCache`)
- Resets any other middleware-scoped state

Call this in `beforeEach`.

### `revokeJtiInCache(jti: string): void`

Directly populates the worker's per-isolate jti revocation cache. The next request carrying a token with that jti will be rejected with `401 session-revoked` via the cache-hit branch (auth.ts:584 → 608) — without any D1 query.

This is the correct way to test jti revocation in integration tests. See the cross-package mock limitation below.

### `backendD1MockFactory(): Record<string, unknown>`

Returns a `vi.mock` factory covering the full D1 store surface constructed by the worker's auth routes:
`D1RateLimitStore`, `D1IdempotencyStore`, `RepoAllowlistStore`, `GitHubAppConfigStore`, `D1TokenStore`, `D1SessionStore`, `D1RevokedJtiStore`.

Declare this once per test file as a hoisted mock:

```ts
vi.mock("@tila/backend-d1", () => backendD1MockFactory());
```

### `resetBackendD1Mocks(): void`

Resets all mutable `vi.fn()` handles to their default return values. Call in `beforeEach` after `_resetMiddlewareStateForTest()`.

### Mutable handles

Individual `vi.fn()` handles are exported for per-test overrides:

| Handle | Store method | Default return |
|--------|-------------|----------------|
| `mockSessionValidate` | `D1SessionStore.validate` | `null` |
| `mockRevokedJtiIsRevoked` | `D1RevokedJtiStore.isRevoked` | `false` |
| `mockTokenValidate` | `D1TokenStore.validate` | `null` |
| `mockRateLimitCheck` | `D1RateLimitStore.check` | `false` |
| `mockRepoIsRegistered` | `RepoAllowlistStore.isRegistered` | `null` |

---

## Per-file `vi.mock` pattern

Each consuming test file MUST declare its own `vi.mock` — vitest hoisting is per-module and the mock cannot be shared across files:

```ts
import { backendD1MockFactory, resetBackendD1Mocks, _resetMiddlewareStateForTest } from "@tila/worker/test-support";
vi.mock("@tila/backend-d1", () => backendD1MockFactory());

beforeEach(() => {
  _resetMiddlewareStateForTest();
  resetBackendD1Mocks();
});
```

---

## WI-x → file → FEATURE-PENDING markers un-skip map

When a WI lands, locate all its pending tests by grepping for the marker:

```
grep -r 'FEATURE-PENDING(WI-A' packages/integration-tests/src/
```

| WI | Issue | File | Marker(s) |
|----|-------|------|-----------|
| WI-A | #123 | `auth-instance-binding.test.ts` | `FEATURE-PENDING(WI-A, #123)` |
| WI-E | #128 | `auth-instance-binding.test.ts` | `FEATURE-PENDING(WI-E, #128)` |
| WI-B1 | #124 | `auth-oidc-generic.test.ts` | `FEATURE-PENDING(WI-B1, #124)` |
| WI-G | #130 | `auth-oidc-generic.test.ts` | `FEATURE-PENDING(WI-G, #130)` |
| WI-C | #126 | `auth-revocation.test.ts` | `FEATURE-PENDING(WI-C, #126)` |
| WI-Q | pool-workers | `auth-github.test.ts` | `FEATURE-PENDING(WI-Q, pool-workers)` |

To un-skip a WI's tests:

1. Implement the deferred fixture stub(s) in `packages/worker/src/test-support/fixtures.ts` using the correct shape from the WI's production implementation.
2. Remove the `featurePending` wrapper (or replace with a plain `describe` block).
3. Run the individual file to verify green: `pnpm --filter @tila/integration-tests exec vitest run src/<file>.test.ts`
4. Run the full suite: `pnpm --filter @tila/integration-tests test`

---

## Cross-package mock limitation

**Problem:** Mocking a `@tila/backend-d1` store *method* from the `integration-tests` package does NOT reliably intercept the worker's internal store construction.

**Root cause:** vitest's `vi.mock` hoisting is per-module. The mock is registered in the integration-tests module graph. The worker's auth middleware constructs `new D1SessionStore(c.env.DB)` inside its own module graph, which resolves `@tila/backend-d1` from the worker package's node_modules resolution path — a different module graph node. This creates a mock→worker→mocked-package import cycle where the mock does not intercept the worker's import.

**What this means for tests:**

- Tests that require D1-store-method return values (e.g., `D1RevokedJtiStore.isRevoked` returning `true`) cannot be reliably driven from `integration-tests/src` files.
- The D1-query revocation branches (auth.ts:596-615, auth.ts:622) should be tested in the worker's co-located unit tests (`packages/worker/src/middleware/auth.test.ts`), which share the same module graph.

**Recommended patterns for integration-tests:**

1. **No-auth / HMAC-tamper level:** Test unauthenticated requests (no `Authorization` header) and signature-forged requests (wrong HMAC key in `Env`). These paths reach failure before any D1 store is queried.
2. **In-process revocation cache:** Use `revokeJtiInCache(jti)` to populate the worker's per-isolate cache directly. The cache-hit branch (auth.ts:584 → 608) returns `session-revoked` before any D1 query — no mock needed.
3. **Payload / issuer / proof-shape level:** For skip-gated OIDC and DPoP tests, validation happens at the token-structure level (issuer allowlist, htu/htm binding). These can be tested without D1 mocks once the fixture stubs are implemented.
4. **Project-mismatch:** The `project-mismatch` guard in `project.ts` fires after auth succeeds but before any DO fetch. No D1 mock is involved — the DO stub in `makeAuthEnv` is sufficient.

**D1-store-dependent assertions belong in worker co-located tests** (`packages/worker/src/middleware/auth.test.ts`, `packages/worker/src/routes/auth-github.test.ts`). These tests use `vi.mock("@tila/backend-d1", ...)` in the same module graph as the production code and reliably intercept store construction.
