import type { SectionState } from "@/lib/query-state";
import { readinessContext } from "@/lib/readiness-context";
import type { WorkCatalogEntry, WorkCatalogResponse } from "@tila/schemas";
import { configuredEntry, declaredEntry } from "../mocks/tasks";

type Ready = Extract<SectionState<WorkCatalogResponse>, { phase: "ready" }>;

const ready = (
  types: WorkCatalogEntry[],
  extra: Partial<Omit<WorkCatalogResponse, "ok" | "types">> = {},
  stale: Ready["stale"] = null,
): SectionState<WorkCatalogResponse> => ({
  phase: "ready",
  data: { ok: true, types, scope: { restricted: false }, ...extra },
  empty: false,
  updatedAt: 1,
  stale,
});

const entry = (
  type: string,
  declaration: WorkCatalogEntry["declaration"],
  count = 1,
): WorkCatalogEntry => ({ type, declaration, count, archived_count: 0 });

const FULL = { legacy: [] as string[], restricted: false, schemaMasked: false };

describe("readinessContext", () => {
  test("names the visible types that declare no lifecycle, sorted", () => {
    const context = readinessContext(
      ready([
        entry("zeta", "undeclared"),
        configuredEntry("bug", 3),
        declaredEntry("note", 1),
        declaredEntry("epic", 0),
      ]),
    );

    expect(context).toEqual({
      ...FULL,
      legacy: ["epic", "note", "zeta"],
      gap: null,
    });
  });

  test("a type with no tasks is still named, so a zero does not hide it", () => {
    expect(readinessContext(ready([declaredEntry("note", 0)]))?.legacy).toEqual(
      ["note"],
    );
  });

  test("every type declaring a lifecycle leaves nothing to explain", () => {
    expect(
      readinessContext(
        ready([configuredEntry("bug", 2), configuredEntry("job", 0)]),
      ),
    ).toBeNull();
  });

  test("an empty project has no types to explain", () => {
    expect(readinessContext(ready([]))).toBeNull();
  });

  test("a failed catalog is unknown coverage, never all declared", () => {
    expect(
      readinessContext({
        phase: "failed",
        kind: "unavailable",
        error: new Error("down"),
      }),
    ).toEqual({ ...FULL, gap: "catalog" });
  });

  test("a stale catalog is unknown too: coverage may have changed", () => {
    const stale = {
      kind: "unavailable" as const,
      error: new Error("down"),
      failedAt: 2,
    };

    expect(
      readinessContext(ready([configuredEntry("bug", 2)], {}, stale)),
    ).toEqual({ ...FULL, gap: "catalog" });
  });

  test("loading and unreadable access say nothing yet", () => {
    expect(readinessContext({ phase: "pending", paused: false })).toBeNull();
    expect(readinessContext("hidden")).toBeNull();
  });

  test("an unreadable schema marks definitions unknown instead of legacy", () => {
    const context = readinessContext(
      ready([entry("bug", "unknown"), entry("task", "unknown")], {
        incomplete: { declared_types: "unavailable" },
      }),
    );

    expect(context).toEqual({ ...FULL, gap: "definitions" });
  });

  test("unknown declarations without an incomplete flag are still a gap", () => {
    expect(readinessContext(ready([entry("bug", "unknown")]))?.gap).toBe(
      "definitions",
    );
  });

  test("unlisted stored types make the named list possibly incomplete", () => {
    const context = readinessContext(
      ready([declaredEntry("note", 0)], {
        incomplete: { in_use_types: "unavailable" },
      }),
    );

    expect(context).toEqual({ ...FULL, legacy: ["note"], gap: "types" });
  });
});

describe("readinessContext for a restricted credential", () => {
  const taskTypes = { taskTypes: true, any: true };
  const recordsOnly = { taskTypes: false, any: true };

  test("a catalog narrowed to some task types never reads as complete", () => {
    const context = readinessContext(
      ready([configuredEntry("bug", 2)], { scope: { restricted: true } }),
    );

    expect(context).toEqual({
      ...FULL,
      gap: null,
      restricted: true,
      schemaMasked: true,
    });
  });

  test("the credential's task-type restriction counts when the scope is silent", () => {
    expect(
      readinessContext(ready([configuredEntry("bug", 2)]), taskTypes),
    ).toEqual({ ...FULL, gap: null, restricted: true, schemaMasked: true });
  });

  test("a records-only restriction leaves a complete task catalog complete", () => {
    // It hides no task type, so there is no caveat about types it cannot see.
    expect(
      readinessContext(ready([configuredEntry("bug", 2)]), recordsOnly),
    ).toBeNull();
  });

  test("a records-only restriction masks the schema without narrowing tasks", () => {
    // An unreadable schema would also read as undeclared here, so the type is
    // legacy as far as this credential can confirm, yet no type is hidden.
    expect(
      readinessContext(ready([entry("task", "undeclared")]), recordsOnly),
    ).toEqual({
      ...FULL,
      legacy: ["task"],
      gap: null,
      restricted: false,
      schemaMasked: true,
    });
  });

  test("an unrestricted credential's undeclared type is stated as declared-absent", () => {
    expect(
      readinessContext(ready([entry("task", "undeclared")]))?.schemaMasked,
    ).toBe(false);
  });

  test("a failed catalog keeps the credential's own restriction", () => {
    const failed: SectionState<WorkCatalogResponse> = {
      phase: "failed",
      kind: "error",
      error: new Error("x"),
    };

    expect(readinessContext(failed, taskTypes)).toEqual({
      ...FULL,
      gap: "catalog",
      restricted: true,
      schemaMasked: true,
    });
    expect(readinessContext(failed, recordsOnly)).toEqual({
      ...FULL,
      gap: "catalog",
      restricted: false,
      schemaMasked: true,
    });
  });
});
