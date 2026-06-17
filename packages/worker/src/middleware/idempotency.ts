import {
  D1IdempotencyStore,
  type IdempotencyStoreLike,
} from "@tila/backend-d1";
import type { Context, MiddlewareHandler } from "hono";
import type { Env, HonoVariables } from "../types";

// ---------------------------------------------------------------------------
// Helper: SHA-256 hex digest
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Default store factory (uses the real D1 binding)
// ---------------------------------------------------------------------------

const defaultMakeStore = (env: Env): IdempotencyStoreLike =>
  new D1IdempotencyStore(env.DB);

// Fire-and-forget Analytics for idempotency-store failures so chronic D1
// problems are observable (mirrors the auth.ts rate_limit_d1_error pattern).
// Never let telemetry break the request.
function emitIdempotencyError(
  c: Context<{ Bindings: Env; Variables: HonoVariables }>,
  phase: string,
): void {
  try {
    c.env.ANALYTICS?.writeDataPoint?.({
      blobs: ["idempotency", phase, c.req.method],
    });
  } catch {
    // swallow
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const ACTIVE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createIdempotencyMiddleware(deps?: {
  makeStore?: (env: Env) => IdempotencyStoreLike;
}): MiddlewareHandler<{ Bindings: Env; Variables: HonoVariables }> {
  return async function idempotencyMiddleware(c, next) {
    // Guard: only activate for unsafe JSON write requests with an Idempotency-Key
    const clientKey = c.req.header("Idempotency-Key");
    const contentType = c.req.header("Content-Type");

    if (
      !ACTIVE_METHODS.has(c.req.method) ||
      !clientKey ||
      !contentType?.includes("application/json")
    ) {
      return next();
    }

    const projectId = c.get("projectId");
    // Caller-scoped: two actors with write access to the same project must not
    // collide on the same client-supplied Idempotency-Key.
    const tokenResult = c.get("tokenResult");
    const caller = tokenResult?.tokenId || tokenResult?.name || "anon";
    const key = `dp:${projectId}:${caller}:${c.req.method}:${c.req.path}:${clientKey}`;
    const store = (deps?.makeStore ?? defaultMakeStore)(c.env);

    let requestHash = "";
    let hit: Awaited<ReturnType<IdempotencyStoreLike["check"]>> = null;
    try {
      // Hash the body WITHOUT consuming the handler's stream.
      const rawBody = await c.req.raw.clone().text();
      requestHash = await sha256Hex(rawBody);
      hit = await store.check(key, projectId);
    } catch (err) {
      // The idempotency store is unreachable. This request opted into
      // exactly-once on a mutating method; failing OPEN would re-run the handler
      // and can double-apply the write (e.g. a second fence bump). Fail CLOSED
      // with a retryable 503 and surface the failure via Analytics.
      console.warn("[idempotency] store unavailable — failing closed:", err);
      emitIdempotencyError(c, "store_check_error");
      return c.json(
        {
          ok: false,
          error: {
            code: "idempotency-unavailable",
            message:
              "Idempotency store is temporarily unavailable; retry the request.",
            retryable: true,
          },
        },
        503,
      );
    }

    if (hit !== null) {
      // hit.requestHash === null matches legacy pre-migration rows that were stored
      // without a body hash — always replay them regardless of the incoming body.
      if (hit.requestHash === requestHash || hit.requestHash === null) {
        const bodyBytes = new TextEncoder().encode(hit.body);
        // Security boundary for replays is auth + project-mismatch middleware that
        // runs earlier in the chain — not the route's requirePermission guard.
        c.res = new Response(hit.body, {
          status: hit.statusCode,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(bodyBytes.byteLength),
            "Idempotency-Replayed": "true",
          },
        });
        return;
      }

      // hit + mismatch: conflict
      return c.json(
        {
          ok: false,
          error: {
            code: "idempotency-key-conflict",
            message: "Idempotency-Key reused with a different request body",
            retryable: false,
          },
        },
        422,
      );
    }

    // Expose the caller-scoped key + body hash so covered write routes can
    // forward them to the DO, which dedups the fence-mutating write inside its
    // own transaction (audit B1). This does NOT change the D1 fast-path store or
    // the fail-closed behavior above — it only threads the already-computed
    // values down to the DO so the cross-store crash window is closed at the
    // source of truth.
    c.set("idempotencyKey", key);
    c.set("idempotencyHash", requestHash);

    // miss: run the handler OUTSIDE the store try/catch so a handler error never
    // triggers the fail-closed path or a re-run.
    await next();

    if (c.res.status >= 200 && c.res.status < 300) {
      try {
        const body = await c.res.clone().text();
        await store.store(key, projectId, c.res.status, body, requestHash);
      } catch (err) {
        // The write already committed; persisting the idempotency record is
        // best-effort. Observe the failure but do not fail the request.
        console.warn(
          "[idempotency] store write failed (write already committed):",
          err,
        );
        emitIdempotencyError(c, "store_write_error");
      }
    }
  };
}
