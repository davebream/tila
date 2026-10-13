import { ApiError, type AppliedSchemaResponse } from "@/lib/api";
import {
  ATTENTION_RULES,
  type AttentionRow,
  type RowState,
  countLabel,
  evaluateOverview,
  isUnconfigured,
  ruleRow,
} from "@/lib/attention";
import type { ErrorKind, SectionState } from "@/lib/query-state";
import type { RecordTypesResponse, WorkCatalogResponse } from "@tila/schemas";
import {
  SCENARIOS,
  type SourceBody,
  deliveryPage,
  runtimeView,
  sourceBodies,
  taskPage,
} from "../fixtures/overview-scenarios";

const rule = (id: string) => {
  const found = ATTENTION_RULES.find((r) => r.id === id);
  if (!found) throw new Error(`no rule ${id}`);
  return found;
};
const uncertain = rule("execution.uncertain");
const suspended = rule("execution.suspended");

function ready<T>(data: T, stale = false): SectionState<T> {
  return {
    phase: "ready",
    data,
    empty: false,
    updatedAt: 1_000,
    stale: stale
      ? { kind: "unavailable", error: new Error("down"), failedAt: 2_000 }
      : null,
  };
}

function failed(kind: ErrorKind, code = `http-${kind}`): SectionState<never> {
  return { phase: "failed", kind, error: new ApiError(code, kind) };
}

const pending: SectionState<never> = { phase: "pending", paused: false };

const readyRow = (total: number, extra: Partial<RowState> = {}): RowState =>
  ({
    kind: "ready",
    total,
    complete: true,
    link: { segment: "queue", search: "" },
    updatedAt: 1_000,
    stale: null,
    ...extra,
  }) as RowState;

function rows(...states: RowState[]): AttentionRow[] {
  return states.map((state, i) => ({
    rule: ATTENTION_RULES[i % ATTENTION_RULES.length],
    state,
  }));
}

/** What each source's `fetch` resolves to, from its HTTP response body. */
function fetched(id: string, body: SourceBody): SectionState<unknown> {
  if ("failure" in body)
    return body.failure === "outage"
      ? failed("unavailable", "do-unreachable")
      : failed("unavailable", "config-unavailable");
  const data = body.data as { result?: unknown };
  if (id === "queue" || id === "queue-lease" || id === "questions-mine")
    return ready(data.result);
  if (id === "deliveries-expired") return ready({ page: data, since: 0 });
  return ready(data);
}

function evaluate(scenario: (typeof SCENARIOS)[number]) {
  const bodies = sourceBodies(scenario.sources);
  const work: WorkCatalogResponse = {
    ok: true,
    types: scenario.work,
    scope: { restricted: false },
  };
  const records: RecordTypesResponse = {
    ok: true,
    types: scenario.records.map((entry) => entry.type),
    entries: scenario.records,
  };
  return evaluateOverview({
    rows: ATTENTION_RULES.map((r) => ({
      rule: r,
      state: ruleRow(r, fetched(r.source.id, bodies[r.source.id])),
    })),
    unconfigured: isUnconfigured({
      schema: ready<AppliedSchemaResponse>(scenario.schema),
      work: ready(work),
      records: ready(records),
    }),
  });
}

test("every rule's source has a scenario body", () => {
  const bodies = sourceBodies(SCENARIOS[0].sources);
  for (const r of ATTENTION_RULES) expect(bodies[r.source.id]).toBeDefined();
});

describe("scenario fixtures", () => {
  test.each(SCENARIOS.map((s) => [s.name, s] as const))(
    "%s",
    (_name, scenario) => {
      const view = evaluate(scenario);
      expect(view.state).toBe(scenario.expected);
      if (scenario.next) {
        const next = view.next;
        expect(next).not.toBeNull();
        expect(
          `/p/test-project/${next?.state.link.segment}${next?.state.link.search}`,
        ).toBe(scenario.next);
      }
    },
  );
});

describe("ruleRow", () => {
  test("reads the rule's count from its source", () => {
    const queue = ready({ counts: { uncertain: 4, suspended: 0 } });
    expect(ruleRow(uncertain, queue)).toMatchObject({
      kind: "ready",
      total: 4,
    });
    expect(ruleRow(suspended, queue)).toMatchObject({
      kind: "ready",
      total: 0,
    });
  });

  test("a forbidden source is hidden, not zero", () => {
    expect(ruleRow(uncertain, failed("forbidden"))).toEqual({ kind: "hidden" });
  });

  test("missing deployment configuration is not an outage", () => {
    const state = failed("unavailable", "config-unavailable");
    expect(ruleRow(uncertain, state)).toEqual({ kind: "not-configured" });
  });

  test.each(["not-found", "unauthenticated", "unavailable", "error"] as const)(
    "a %s failure is an unknown, never a count",
    (kind) => {
      expect(ruleRow(uncertain, failed(kind))).toMatchObject({
        kind: "failed",
        error: kind,
      });
    },
  );

  test("keeps last-known data marked stale", () => {
    const row = ruleRow(
      uncertain,
      ready({ counts: { uncertain: 0, suspended: 0 } }, true),
    );
    expect(row).toMatchObject({ kind: "ready", total: 0 });
    expect(row.kind === "ready" && row.stale).toBeTruthy();
  });
});

describe("rule observations", () => {
  test("failed work is not applicable when no type declares the outcome", () => {
    expect(ruleRow(rule("work.failed"), ready(taskPage(0, [])))).toMatchObject({
      kind: "not-applicable",
    });
    expect(
      ruleRow(rule("work.failed"), ready(taskPage(2, ["bug", "story"]))),
    ).toMatchObject({ kind: "ready", total: 2, scope: "types: bug, story" });
  });

  test("blocked work links to the same filter it counted", () => {
    expect(ruleRow(rule("work.blocked"), ready(taskPage(7)))).toMatchObject({
      kind: "ready",
      total: 7,
      link: { segment: "tasks", search: "?blocked=1" },
    });
  });

  test("expired deliveries link with the cutoff their count used", () => {
    const row = ruleRow(
      rule("delivery.expired-recent"),
      ready({ page: deliveryPage(3), since: 1_700_000_000_000 }),
    );
    expect(row).toMatchObject({
      kind: "ready",
      total: 3,
      link: {
        segment: "deliveries",
        search: "?state=expired&expires_after=1700000000000",
      },
    });
  });

  test("a server without delivery totals is not shown as zero", () => {
    const { total: _total, ...page } = deliveryPage(0);
    expect(
      ruleRow(rule("delivery.wake-suppressed"), ready(page)),
    ).toMatchObject({ kind: "not-applicable" });
  });

  test("unconfigured conversations are not an outage", () => {
    expect(
      ruleRow(
        rule("delivery.wake-suppressed"),
        failed("unavailable", "config-unavailable"),
      ),
    ).toEqual({ kind: "not-configured" });
  });

  test.each<[string, Parameters<typeof runtimeView>[0], string | undefined]>([
    ["a complete scan", { total: 2 }, undefined],
    ["a partial scan", { total: 2, complete: false }, "first 10 agents only"],
    [
      "a run-store outage",
      { total: 0, runs: "unavailable" },
      "run records unavailable",
    ],
  ])("runtime counts state %s", (_name, view, scope) => {
    const row = ruleRow(rule("runtime.occupant"), ready(runtimeView(view)));
    expect(row).toMatchObject({
      kind: "ready",
      total: view.total,
      complete: scope === undefined,
      link: { segment: "runtime", search: "?filter=attention" },
    });
    expect(row.kind === "ready" && row.scope).toBe(scope ?? undefined);
  });
});

describe("evaluateOverview", () => {
  test("a finding wins and is the next action even while others fail", () => {
    const view = evaluateOverview({
      rows: rows(readyRow(2), {
        kind: "failed",
        error: "unavailable",
        cause: null,
      }),
      unconfigured: false,
    });
    expect(view.state).toBe("attention");
    expect(view.next?.rule.id).toBe("execution.uncertain");
    expect(view.incomplete).toBe(true);
  });

  test("red findings come before amber, then larger counts", () => {
    const view = evaluateOverview({
      rows: [
        { rule: suspended, state: readyRow(50) },
        { rule: uncertain, state: readyRow(1) },
      ],
      unconfigured: false,
    });
    expect(view.rows.map((row) => row.rule.id)).toEqual([
      "execution.uncertain",
      "execution.suspended",
    ]);
  });

  test("all checks complete and empty is idle", () => {
    expect(
      evaluateOverview({
        rows: rows(readyRow(0), readyRow(0)),
        unconfigured: false,
      }).state,
    ).toBe("idle");
  });

  test.each<[string, RowState]>([
    ["failed", { kind: "failed", error: "unavailable", cause: null }],
    ["not configured", { kind: "not-configured" }],
    [
      "stale",
      readyRow(0, {
        stale: { kind: "unavailable", error: null, failedAt: 1 },
      } as Partial<RowState>),
    ],
    ["partial", readyRow(0, { complete: false } as Partial<RowState>)],
  ])(
    "one %s check beside an empty one is partial, not idle",
    (_name, state) => {
      const view = evaluateOverview({
        rows: rows(readyRow(0), state),
        unconfigured: false,
      });
      expect(view.state).toBe("partial");
      expect(view.incomplete).toBe(true);
    },
  );

  test("nothing completed is unknown", () => {
    const down: RowState = {
      kind: "failed",
      error: "unavailable",
      cause: null,
    };
    expect(
      evaluateOverview({ rows: rows(down, down), unconfigured: false }).state,
    ).toBe("unknown");
  });

  test("still loading is pending, never idle", () => {
    expect(
      evaluateOverview({
        rows: rows(readyRow(0), { kind: "pending" }),
        unconfigured: false,
      }).state,
    ).toBe("pending");
  });

  test("no visible checks is unchecked, and lists what was hidden", () => {
    const view = evaluateOverview({
      rows: rows({ kind: "hidden" }, { kind: "hidden" }),
      unconfigured: false,
    });
    expect(view.state).toBe("unchecked");
    expect(view.hidden).toHaveLength(2);
  });

  test("an empty new project is setup before checks finish", () => {
    expect(
      evaluateOverview({
        rows: rows({ kind: "pending" }, { kind: "pending" }),
        unconfigured: true,
      }).state,
    ).toBe("setup");
  });
});

describe("isUnconfigured", () => {
  const notApplied: AppliedSchemaResponse = {
    ok: true,
    schema: null,
    version: null,
    revision: 0,
  };
  const noSchema = ready(notApplied);
  const noWork = ready<WorkCatalogResponse>({
    ok: true,
    types: [],
    scope: { restricted: false },
  });
  const noRecords = ready<RecordTypesResponse>({
    ok: true,
    types: [],
    entries: [],
  });

  test("an empty project with no definitions", () => {
    expect(
      isUnconfigured({ schema: noSchema, work: noWork, records: noRecords }),
    ).toBe(true);
  });

  test("unreadable records are not evidence of an empty project", () => {
    expect(
      isUnconfigured({
        schema: noSchema,
        work: noWork,
        records: failed("forbidden"),
      }),
    ).toBe(false);
  });

  test.each<[string, Partial<Parameters<typeof isUnconfigured>[0]>]>([
    ["the schema failed", { schema: failed("unavailable") }],
    ["the schema is still loading", { schema: pending }],
    ["the schema is stale", { schema: ready(notApplied, true) }],
    [
      "only archived tasks exist",
      {
        work: ready<WorkCatalogResponse>({
          ok: true,
          types: [
            {
              type: "bug",
              declaration: "undeclared",
              count: 0,
              archived_count: 1,
            },
          ],
          scope: { restricted: false },
        }),
      },
    ],
    [
      "task counts are unavailable",
      {
        work: ready<WorkCatalogResponse>({
          ok: true,
          types: [],
          scope: { restricted: false },
          incomplete: { in_use_types: "unavailable" },
        }),
      },
    ],
    ["records failed", { records: failed("unavailable") }],
  ])("not when %s", (_name, override) => {
    expect(
      isUnconfigured({
        schema: noSchema,
        work: noWork,
        records: noRecords,
        ...override,
      }),
    ).toBe(false);
  });
});

test("countLabel formats large counts and singulars", () => {
  expect(countLabel(uncertain, 1)).toBe(
    "1 execution with an uncertain outcome",
  );
  expect(countLabel(suspended, 10_000)).toBe("10,000 suspended executions");
});
