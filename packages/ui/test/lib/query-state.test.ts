import { ApiError, listClaims } from "@/lib/api";
import {
  type QueryLike,
  classifyApiError,
  deriveSectionState,
} from "@/lib/query-state";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";

describe("classifyApiError", () => {
  test.each([
    [
      "status 403",
      new ApiError("permission-denied", "no", undefined, 403),
      "forbidden",
    ],
    [
      "forbidden code without status",
      new ApiError("forbidden", "no"),
      "forbidden",
    ],
    ["unparsable 403 body", new ApiError("http-403", "HTTP 403"), "forbidden"],
    [
      "status 404",
      new ApiError("not-found", "gone", undefined, 404),
      "not-found",
    ],
    ["unparsable 404 body", new ApiError("http-404", "HTTP 404"), "not-found"],
    [
      "status 401",
      new ApiError("not-configured", "x", undefined, 401),
      "unauthenticated",
    ],
    [
      "status 503",
      new ApiError("do-unreachable", "x", undefined, 503),
      "unavailable",
    ],
    [
      "status 500 internal",
      new ApiError("internal", "x", undefined, 500),
      "unavailable",
    ],
    [
      "typed unavailable code",
      new ApiError("artifact-storage-unavailable", "x"),
      "unavailable",
    ],
    ["network failure", new ApiError("network-error", "x"), "unavailable"],
    [
      "rate limit",
      new ApiError("rate-limited", "x", undefined, 429),
      "unavailable",
    ],
    ["bare TypeError", new TypeError("Failed to fetch"), "unavailable"],
    [
      "step-up on a 403",
      new ApiError("step-up-required", "x", undefined, 403),
      "error",
    ],
    [
      "unrecognised 400",
      new ApiError("invalid-request", "x", undefined, 400),
      "error",
    ],
    ["non-Error value", "boom", "error"],
  ])("%s", (_name, error, kind) => {
    expect(classifyApiError(error)).toBe(kind);
  });

  test("a status wins over a contradictory code", () => {
    expect(
      classifyApiError(new ApiError("internal", "x", undefined, 403)),
    ).toBe("forbidden");
  });
});

describe("ApiError status", () => {
  test("is captured from the failed response", async () => {
    server.use(
      http.get("*/projects/*/claims", () =>
        HttpResponse.json(
          { ok: false, error: { code: "permission-denied", message: "no" } },
          { status: 403 },
        ),
      ),
    );

    const error = await listClaims("test-project").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe("permission-denied");
  });

  test("is absent for a network failure", async () => {
    server.use(http.get("*/projects/*/claims", () => HttpResponse.error()));

    const error = await listClaims("test-project").catch((e: unknown) => e);

    expect((error as ApiError).code).toBe("network-error");
    expect((error as ApiError).status).toBeUndefined();
  });
});

function query<T>(over: Partial<QueryLike<T>>): QueryLike<T> {
  return {
    data: undefined,
    error: null,
    status: "pending",
    fetchStatus: "fetching",
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    ...over,
  };
}

describe("deriveSectionState", () => {
  test("a disabled query is pending, never empty", () => {
    expect(
      deriveSectionState(query<string[]>({ fetchStatus: "idle" })),
    ).toEqual({ phase: "pending", paused: false });
  });

  test("an offline-paused first fetch is pending and paused", () => {
    expect(
      deriveSectionState(query<string[]>({ fetchStatus: "paused" })),
    ).toEqual({ phase: "pending", paused: true });
  });

  test("a successful empty list is ready and empty", () => {
    const state = deriveSectionState(
      query<string[]>({ status: "success", data: [], dataUpdatedAt: 5 }),
    );
    expect(state).toMatchObject({
      phase: "ready",
      empty: true,
      updatedAt: 5,
      stale: null,
    });
  });

  test("a successful non-empty list is ready and not empty", () => {
    expect(
      deriveSectionState(query({ status: "success", data: ["a"] })),
    ).toMatchObject({ phase: "ready", empty: false, stale: null });
  });

  test("isEmpty overrides the array default", () => {
    const state = deriveSectionState(
      query({ status: "success", data: { claims: [] } }),
      { isEmpty: (d) => d.claims.length === 0 },
    );
    expect(state).toMatchObject({ phase: "ready", empty: true });
  });

  test("an error with no data is failed", () => {
    const error = new ApiError("do-unreachable", "x", undefined, 503);
    expect(deriveSectionState(query({ status: "error", error }))).toEqual({
      phase: "failed",
      kind: "unavailable",
      error,
    });
  });

  test("a 5xx after a success keeps the last-good data as stale", () => {
    const error = new ApiError("do-unreachable", "x", undefined, 503);
    const state = deriveSectionState(
      query({
        status: "error",
        error,
        data: ["a"],
        dataUpdatedAt: 100,
        errorUpdatedAt: 200,
      }),
    );
    expect(state).toEqual({
      phase: "ready",
      data: ["a"],
      empty: false,
      updatedAt: 100,
      stale: { kind: "unavailable", error, failedAt: 200 },
    });
  });

  test("a stale empty result stays marked stale", () => {
    const state = deriveSectionState(
      query<string[]>({
        status: "error",
        error: new ApiError("internal", "x", undefined, 500),
        data: [],
      }),
    );
    expect(state).toMatchObject({
      phase: "ready",
      empty: true,
      stale: { kind: "unavailable" },
    });
  });

  test.each([
    [
      "403",
      new ApiError("permission-denied", "x", undefined, 403),
      "forbidden",
    ],
    ["404", new ApiError("not-found", "x", undefined, 404), "not-found"],
    [
      "401",
      new ApiError("not-configured", "x", undefined, 401),
      "unauthenticated",
    ],
  ])("a %s on refresh drops the last-good data", (_status, error, kind) => {
    expect(
      deriveSectionState(query({ status: "error", error, data: ["a"] })),
    ).toEqual({ phase: "failed", kind, error });
  });
});
