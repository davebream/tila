import type { DoIdempotency } from "@tila/ops-sqlite";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Read the idempotency context threaded from the worker (audit B1). The worker
 * idempotency middleware already computed the caller-scoped key and request-body
 * hash and forwarded them as headers; the DO uses them verbatim so the DO dedup
 * key is byte-identical to the D1 key. Returns undefined when no Idempotency-Key
 * was supplied (the op then runs with no dedup, unchanged behavior).
 *
 * KEY CONTRACT: the forwarded `Idempotency-Key` MUST be the worker's composite
 * caller-scoped key — `dp:${projectId}:${caller}:${method}:${path}:${clientKey}`
 * (see middleware/idempotency.ts). The `_do_idempotency` table is keyed on this
 * string ALONE — it has no separate resource/method/path column — so a raw,
 * unscoped client key would risk cross-resource / cross-caller false-replay.
 * No `serialize` hook is supplied here: the helper stores the op's domain result
 * with the identity default, and each route re-serializes that result through its
 * own (deterministic) serializer after the op returns, so the replayed HTTP body
 * matches the original byte-for-byte without the op needing to know route shapes.
 */
export function idempotencyFrom<T>(c: Context): DoIdempotency<T> | undefined {
  const key = c.req.header("Idempotency-Key");
  if (!key) return undefined;
  const requestHash = c.req.header("X-Idempotency-Hash") ?? null;
  return { key, requestHash };
}

export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  extras?: Record<string, unknown>,
  retryable = false,
) {
  return c.json(
    {
      ok: false,
      error: {
        code,
        message,
        retryable,
        ...extras,
      },
    },
    status,
  );
}

export function formatZodIssues(
  issues: ReadonlyArray<{
    path: readonly (string | number)[];
    message: string;
  }>,
): string {
  return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/**
 * Return a 200 JSON success body AND set the `X-Rows-Affected` header so the
 * Worker's `do-forward.ts` can read the real mutation count for Analytics.
 * Use for mutating routes that have the row count in hand (entity create/update/
 * archive/relationship; record create/set/put/patch/archive/unarchive; artifact
 * pointer/tombstone/relationship). Read-only routes return via `c.json()` directly
 * and emit `rowsAffected: 0` (the default in `do-forward.ts`).
 */
export function jsonOkRows(
  c: Context,
  body: Record<string, unknown>,
  rowsAffected: number,
) {
  c.header("X-Rows-Affected", String(rowsAffected));
  return c.json({ ok: true, ...body });
}
