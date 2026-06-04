# Auth Middleware Design

## Context

The Worker needs a unified auth layer that handles both short-lived GitHub session tokens and long-lived D1 API tokens. All downstream route handlers receive a `UnifiedTokenResult` regardless of auth path.

> This decision was driven by the need to support both human users (GitHub OAuth) and machine agents (API tokens) through a single middleware chain. See ADR-007 for the full rationale.

## Approach

Bearer token verification via D1 token store with a two-phase resolution:

1. **Extract** token from `Authorization: Bearer <token>` header
2. **Classify** — GitHub session tokens start with `ghs_`, API tokens start with `tila_`
3. **Resolve** through the appropriate store
4. **Attach** `UnifiedTokenResult` to Hono context

### Token Classification

| Prefix | Type | Store | TTL |
|--------|------|-------|-----|
| `ghs_` | GitHub session | D1 sessions table | 8 hours |
| `tila_` | API token | D1 tokens table | Until revoked |
| Other | Invalid | — | — |

## Implementation

The middleware is a Hono middleware factory:

```typescript
import type { Context, Next } from "hono";
import { D1TokenStore } from "@tila/backend-d1";

export function authMiddleware(env: Env) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    const token = header.slice(7);
    const store = new D1TokenStore(env.DB);
    const result = await store.resolve(token);

    if (!result) {
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    }

    c.set("auth", result);
    return next();
  };
}
```

## Fencing Integration

Every destructive operation downstream of a claim must carry and validate a fencing token:

```typescript
const claim = await claimOps.acquire({
  resource: "task.auth-middleware",
  mode: "exclusive",
  ttl_ms: 600_000,
});

await entityOps.update(entityId, data, { fence: claim.fence });
```

The DO validates fences on every write. Stale fences are rejected with `FENCE_VIOLATION`.

## Error Responses

All error responses follow a consistent shape:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Bearer token is missing or invalid"
  }
}
```

### Error Codes

- **`UNAUTHORIZED`** — missing or invalid token
- **`TOKEN_REVOKED`** — token was explicitly revoked
- **`SESSION_EXPIRED`** — GitHub session past TTL
- **`RATE_LIMITED`** — too many requests (429)
- **`FENCE_VIOLATION`** — stale fencing token on write

## Testing Strategy

- [ ] Unit tests for token classification logic
- [x] Integration tests for the full middleware chain
- [x] Edge cases: malformed headers, empty tokens, expired sessions
- [ ] Load testing for D1 lookup latency under concurrent requests

## Performance Notes

D1 lookup latency is **~2ms p50** in the same region. The auth middleware adds negligible overhead for single-request flows. For batch operations, consider caching the `UnifiedTokenResult` on the Hono context to avoid redundant D1 lookups within a single request lifecycle.

> **Open question:** Should we add a short-lived in-memory cache (30s TTL) for token lookups? This would reduce D1 reads for agents making rapid sequential requests, but introduces a window where revoked tokens remain valid. Current decision: **no cache** — correctness over performance for auth.
