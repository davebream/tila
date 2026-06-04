import {
  D1IdempotencyStore,
  type IdempotencyStoreLike,
} from "@tila/backend-d1";
import type { MiddlewareHandler } from "hono";
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

    try {
      // Hash the body WITHOUT consuming the handler's stream
      const rawBody = await c.req.raw.clone().text();
      const requestHash = await sha256Hex(rawBody);

      const projectId = c.get("projectId");
      const key = `dp:${projectId}:${c.req.method}:${c.req.path}:${clientKey}`;

      const store = (deps?.makeStore ?? defaultMakeStore)(c.env);
      const hit = await store.check(key, projectId);

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

      // miss: run the handler, then store if 2xx
      await next();

      if (c.res.status >= 200 && c.res.status < 300) {
        const body = await c.res.clone().text();
        await store.store(key, projectId, c.res.status, body, requestHash);
      }
    } catch (err) {
      // fail-open: log and proceed as if idempotency were absent
      console.warn("[idempotency] middleware error — failing open:", err);
      return next();
    }
  };
}
