import { ApiError } from "@/lib/api";

export type ErrorKind =
  | "forbidden"
  | "not-found"
  | "unauthenticated"
  | "unavailable"
  | "error";

/**
 * Sort a failed request into what the viewer can act on. Status wins over the
 * server code; the code is the fallback when no status was captured.
 */
export function classifyApiError(error: unknown): ErrorKind {
  if (error instanceof ApiError) {
    const { status, code } = error;
    if (code === "step-up-required") return "error";
    if (
      status === 403 ||
      code === "permission-denied" ||
      code === "forbidden" ||
      code === "http-403"
    ) {
      return "forbidden";
    }
    if (status === 404 || code === "not-found" || code === "http-404") {
      return "not-found";
    }
    if (status === 401 || code === "not-configured" || code === "http-401") {
      return "unauthenticated";
    }
    if (
      (status !== undefined && status >= 500) ||
      code === "network-error" ||
      code === "rate-limited" ||
      code === "do-unreachable" ||
      code === "internal" ||
      code.endsWith("-unavailable") ||
      /^http-5\d\d$/.test(code)
    ) {
      return "unavailable";
    }
    return "error";
  }
  if (error instanceof TypeError) return "unavailable";
  return "error";
}

/** The slice of a TanStack `UseQueryResult` that section state is derived from. */
export type QueryLike<T> = {
  data: T | undefined;
  error: unknown;
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  dataUpdatedAt: number;
  errorUpdatedAt: number;
};

export type StaleInfo = {
  kind: ErrorKind;
  error: unknown;
  /** When the last refresh failed. */
  failedAt: number;
};

export type SectionState<T> =
  /** No data yet: loading, offline-paused, or the query is disabled. */
  | { phase: "pending"; paused: boolean }
  /** No usable data and the request failed. */
  | { phase: "failed"; kind: ErrorKind; error: unknown }
  /**
   * Data is available. `stale` is set when a later refresh failed, so the data
   * is the last success rather than current. `empty` is only trustworthy as an
   * affirmative absence when `stale` is null.
   */
  | {
      phase: "ready";
      data: T;
      empty: boolean;
      updatedAt: number;
      stale: StaleInfo | null;
    };

const defaultIsEmpty = (data: unknown) =>
  Array.isArray(data) && data.length === 0;

export function deriveSectionState<T>(
  q: QueryLike<T>,
  opts?: { isEmpty?: (data: T) => boolean },
): SectionState<T> {
  const isEmpty = opts?.isEmpty ?? defaultIsEmpty;
  const ready = (data: T, stale: StaleInfo | null): SectionState<T> => ({
    phase: "ready",
    data,
    empty: isEmpty(data),
    updatedAt: q.dataUpdatedAt,
    stale,
  });

  if (q.status === "error") {
    const kind = classifyApiError(q.error);
    // Losing access or the resource means the last-good data is no longer
    // something the viewer is allowed to see as current.
    const withdrawn =
      kind === "forbidden" ||
      kind === "not-found" ||
      kind === "unauthenticated";
    if (q.data === undefined || withdrawn) {
      return { phase: "failed", kind, error: q.error };
    }
    return ready(q.data, { kind, error: q.error, failedAt: q.errorUpdatedAt });
  }
  if (q.data === undefined) {
    return { phase: "pending", paused: q.fetchStatus === "paused" };
  }
  return ready(q.data, null);
}
