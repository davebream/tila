import { readFileSync } from "node:fs";
import { parseTilaSchemaToml } from "@tila/core";
import { type Entity, TilaSchemaTomlSchema } from "@tila/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquire } from "../src/coordination-ops";
import { create, get, update } from "../src/entity-ops";
import { GateBlockedError } from "../src/gate-ops";
import {
  type ReadinessSnapshot,
  blockedTaskIds,
  computeReadyEntities,
  evaluateReadiness,
  isTerminal,
  readReadinessSnapshot,
} from "../src/ready-ops";
import * as schema from "../src/schema";
import { applySchema } from "../src/schema-ops";
import { type TestDb, createTestDb } from "./helpers";
import {
  expectedReadyIds,
  lifecycleDefinition,
  readinessOrigin,
  seedReadinessFixture,
} from "./readiness-fixture";

let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
  seedReadinessFixture(fixture.db);
});
afterEach(() => fixture.rawDb.close());

it("uses explicit successful outcomes, hard/soft dependencies, gates, and archive state", () => {
  expect(
    computeReadyEntities(fixture.db)
      .map((entity) => entity.id)
      .sort(),
  ).toEqual(expectedReadyIds);
  expect(
    computeReadyEntities(fixture.db, { includeSoftBlocked: true }).map(
      (entity) => entity.id,
    ),
  ).toContain("soft");
  expect(
    computeReadyEntities(fixture.db, { type: "issue", limit: 1 }),
  ).toHaveLength(1);
});

it("diagnoses cycles and missing work, and rejects legacy work for managed admission", () => {
  const snapshot = readReadinessSnapshot(fixture.db);
  // Simulate incomplete external/imported dependency evidence without bypassing
  // the database's foreign-key constraint in the persisted fixture.
  snapshot.entities.delete("absent");
  expect(evaluateReadiness(snapshot, "cycle-a", true).reasons).toContainEqual(
    expect.objectContaining({ code: "dependency-cycle" }),
  );
  expect(evaluateReadiness(snapshot, "missing", true).reasons).toContainEqual({
    code: "dependency-missing",
    resource: "absent",
  });
  expect(evaluateReadiness(snapshot, "absent", true).reasons).toEqual([
    { code: "missing", resource: "absent" },
  ]);
  expect(
    evaluateReadiness(snapshot, "legacy-open", true).reasons,
  ).toContainEqual({ code: "lifecycle-unconfigured", resource: "legacy-open" });
  expect(evaluateReadiness(snapshot, "archived", true).reasons).toContainEqual({
    code: "archived",
    resource: "archived",
  });
});

it("checks gates for custom terminal fields inside the fenced write", () => {
  const claim = acquire(
    fixture.db,
    "gated",
    readinessOrigin,
    "exclusive",
    60_000,
  );
  expect(claim.acquired).toBe(true);
  expect(() =>
    update(
      fixture.db,
      "gated",
      { phase: "shipped" },
      claim.fence,
      readinessOrigin,
    ),
  ).toThrow(GateBlockedError);
  expect(get(fixture.db, "gated")?.data.phase).toBe("todo");
  expect(() =>
    update(
      fixture.db,
      "gated",
      { phase: "typo" },
      claim.fence,
      readinessOrigin,
    ),
  ).toThrow("Invalid lifecycle state");
});

it("preserves legacy closed/archive readiness but never guesses dependency success for managed work", () => {
  for (const [id, status] of Object.entries({
    "old-closed": "closed",
    "old-done": "done",
    "old-ready": "open",
    "old-blocked": "open",
  })) {
    create(
      fixture.db,
      { id, type: "task", data: { status }, created_by: "test" },
      1,
      readinessOrigin,
    );
  }
  for (const [from_id, to_id] of [
    ["old-closed", "old-ready"],
    ["old-done", "old-blocked"],
    ["old-closed", "ready"],
  ])
    fixture.db
      .insert(schema.entityRelationships)
      .values({
        from_id,
        to_id,
        type: "blocks",
        created_at: 1,
        schema_version: 1,
      })
      .run();
  expect(computeReadyEntities(fixture.db).map((entity) => entity.id)).toContain(
    "old-ready",
  );
  expect(
    computeReadyEntities(fixture.db).map((entity) => entity.id),
  ).not.toContain("old-blocked");
  expect(
    evaluateReadiness(readReadinessSnapshot(fixture.db), "ready", true).reasons,
  ).toContainEqual({
    code: "dependency-lifecycle-unconfigured",
    resource: "old-closed",
  });
  fixture.db
    .update(schema.entities)
    .set({ archived: 1 })
    .where(eq(schema.entities.id, "old-done"))
    .run();
  expect(computeReadyEntities(fixture.db).map((entity) => entity.id)).toContain(
    "old-blocked",
  );
});

it("readiness never resolves gates or appends journal entries", () => {
  const before = fixture.rawDb
    .prepare("SELECT count(*) AS n FROM journal")
    .get();
  computeReadyEntities(fixture.db);
  expect(
    fixture.rawDb.prepare("SELECT count(*) AS n FROM journal").get(),
  ).toEqual(before);
  expect(
    fixture.rawDb
      .prepare("SELECT resolved_at FROM gates WHERE id = 'gate-2'")
      .get(),
  ).toEqual({ resolved_at: null });
});

it("validates lifecycle mappings and the checked-in task definition", () => {
  const parsed = parseTilaSchemaToml(lifecycleDefinition);
  for (const patch of [
    { field: "absent" },
    { dispatchable: ["shipped"] },
    { dependency_satisfied: ["todo"] },
    { on_start: "shipped" },
    { outcomes: { success: "unknown" } },
    { terminal: ["unknown"] },
  ]) {
    expect(
      TilaSchemaTomlSchema.safeParse({
        ...parsed,
        work_units: {
          issue: {
            ...parsed.work_units.issue,
            lifecycle: { ...parsed.work_units.issue.lifecycle, ...patch },
          },
        },
      }).success,
    ).toBe(false);
  }
  const checkedIn = parseTilaSchemaToml(
    readFileSync(new URL("../../../tila.schema.toml", import.meta.url), "utf8"),
  );
  expect(checkedIn.work_units.task.lifecycle?.dependency_satisfied).toEqual([
    "done",
  ]);
  expect(checkedIn.work_units.task.lifecycle?.terminal).toContain("cancelled");
});

describe("blockedTaskIds", () => {
  const DEPENDENCY_CODES = new Set([
    "dependency-unsatisfied",
    "dependency-missing",
    "dependency-cycle",
    "dependency-lifecycle-unconfigured",
  ]);

  /**
   * Independent oracle: every open (not archived, not terminal) task whose
   * readiness names an unresolved prerequisite. It checks every task, with no
   * shortcut for tasks without predecessors.
   */
  function blockedByReadiness(snapshot: ReadinessSnapshot): string[] {
    return [...snapshot.entities.values()]
      .filter((entity) => {
        const lifecycle =
          snapshot.definition?.work_units[entity.type]?.lifecycle;
        const state = entity.data[lifecycle?.field ?? "status"];
        const terminal = lifecycle
          ? typeof state === "string" && lifecycle.terminal.includes(state)
          : state === "closed";
        return (
          !entity.archived &&
          !terminal &&
          evaluateReadiness(snapshot, entity.id).reasons.some((reason) =>
            DEPENDENCY_CODES.has(reason.code),
          )
        );
      })
      .map((entity) => entity.id)
      .sort();
  }

  it("matches readiness on random graphs with cycles, missing and archived tasks", () => {
    const definition = parseTilaSchemaToml(lifecycleDefinition);
    let seed = 306;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(values: readonly T[]) =>
      values[Math.floor(random() * values.length)];
    for (let round = 0; round < 200; round++) {
      const size = 2 + Math.floor(random() * 14);
      const ids = Array.from({ length: size }, (_, i) => `t${i}`);
      const entities = new Map<string, Entity>();
      for (const id of ids) {
        // Some ids stay absent: edges to them model missing predecessors.
        if (random() < 0.1) continue;
        const lifecycle = random() < 0.5;
        entities.set(id, {
          id,
          type: lifecycle ? "issue" : "task",
          schema_version: 1,
          data: lifecycle
            ? { phase: pick(["todo", "working", "shipped", "aborted"]) }
            : random() < 0.2
              ? {}
              : { status: pick(["open", "closed", "done"]) },
          archived: random() < 0.15 ? 1 : 0,
          created_at: 0,
          updated_at: 0,
          created_by: "test",
          tags: [],
        } as Entity);
      }
      const predecessors = new Map<string, string[]>();
      const edges = Math.floor(random() * size * 1.5);
      for (let e = 0; e < edges; e++) {
        const from = pick(ids);
        const to = pick(ids);
        predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
      }
      const snapshot: ReadinessSnapshot = {
        definition,
        entities,
        predecessors,
        gates: new Map(),
      };
      expect(sorted(blockedTaskIds(snapshot))).toEqual(
        blockedByReadiness(snapshot),
      );
    }
  });

  it("handles a 5,000-task chain in one pass", () => {
    const entities = new Map<string, Entity>();
    const predecessors = new Map<string, string[]>();
    for (let i = 0; i < 5_000; i++) {
      entities.set(`c${i}`, {
        id: `c${i}`,
        type: "task",
        schema_version: 1,
        data: { status: "open" },
        archived: 0,
        created_at: 0,
        updated_at: 0,
        created_by: "test",
        tags: [],
      } as Entity);
      if (i > 0) predecessors.set(`c${i}`, [`c${i - 1}`]);
    }
    const started = performance.now();
    const blocked = blockedTaskIds({
      definition: null,
      entities,
      predecessors,
      gates: new Map(),
    });
    expect(blocked.size).toBe(4_999);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  /** `issue` uses the `phase` lifecycle; `task` is legacy, keyed on `status`. */
  interface Seeded {
    type: "issue" | "task";
    state: string;
    archived?: true;
  }
  const issue = (state: string, archived?: true): Seeded => ({
    type: "issue",
    state,
    archived,
  });
  const legacy = (state: string, archived?: true): Seeded => ({
    type: "task",
    state,
    archived,
  });
  interface Scenario {
    tasks: Record<string, Seeded>;
    edges?: [from: string, to: string, type?: "blocks" | "soft-blocks"][];
    /** Resources with a pending gate. */
    gates?: string[];
    /** Removed from the snapshot to simulate missing dependency evidence. */
    dropped?: string[];
    blocked: string[];
  }

  const scenarios: Record<string, Scenario> = {
    "a chain of blocks, including through a successful predecessor": {
      tasks: {
        a: issue("todo"),
        b: issue("todo"),
        c: issue("working"),
        done: issue("shipped"),
        next: issue("todo"),
        after: issue("todo"),
        root: issue("todo"),
        middle: issue("shipped"),
        leaf: issue("todo"),
      },
      edges: [
        ["a", "b"],
        ["b", "c"],
        ["done", "next"],
        ["next", "after"],
        ["root", "middle"],
        ["middle", "leaf"],
      ],
      blocked: ["after", "b", "c", "leaf"],
    },
    "a cycle between lifecycle-configured tasks": {
      tasks: {
        x: issue("todo"),
        y: issue("todo"),
        z: issue("todo"),
        "shipped-x": issue("shipped"),
        "shipped-y": issue("shipped"),
        "after-shipped-cycle": issue("todo"),
      },
      edges: [
        ["x", "y"],
        ["y", "x"],
        ["x", "z"],
        ["shipped-x", "shipped-y"],
        ["shipped-y", "shipped-x"],
        ["shipped-x", "after-shipped-cycle"],
      ],
      blocked: ["after-shipped-cycle", "x", "y", "z"],
    },
    "a missing predecessor": {
      tasks: {
        gone: issue("todo"),
        managed: issue("todo"),
        "legacy-after-gone": legacy("open"),
      },
      edges: [
        ["gone", "managed"],
        ["gone", "legacy-after-gone"],
      ],
      dropped: ["gone"],
      // Legacy work keeps the old predicate: absent evidence is not reported.
      blocked: ["managed"],
    },
    "mixed lifecycle and legacy tasks": {
      tasks: {
        "legacy-open": legacy("open"),
        "legacy-closed": legacy("closed"),
        "issue-open": issue("todo"),
        "issue-done": issue("shipped"),
        "managed-after-legacy-open": issue("todo"),
        "managed-after-legacy-closed": issue("todo"),
        "legacy-after-issue-open": legacy("open"),
        "legacy-after-issue-done": legacy("open"),
        "legacy-after-legacy-open": legacy("open"),
        "legacy-after-legacy-closed": legacy("open"),
      },
      edges: [
        ["legacy-open", "managed-after-legacy-open"],
        ["legacy-closed", "managed-after-legacy-closed"],
        ["issue-open", "legacy-after-issue-open"],
        ["issue-done", "legacy-after-issue-done"],
        ["legacy-open", "legacy-after-legacy-open"],
        ["legacy-closed", "legacy-after-legacy-closed"],
      ],
      blocked: [
        "legacy-after-issue-open",
        "legacy-after-legacy-open",
        "managed-after-legacy-closed",
        "managed-after-legacy-open",
      ],
    },
    "a soft-blocks edge": {
      tasks: {
        first: issue("todo"),
        soft: issue("todo"),
        shipped: issue("shipped"),
        "soft-after-shipped": issue("todo"),
      },
      edges: [
        ["first", "soft", "soft-blocks"],
        ["shipped", "soft-after-shipped", "soft-blocks"],
      ],
      blocked: ["soft"],
    },
    "an archived predecessor": {
      tasks: {
        "archived-open": issue("todo", true),
        "after-archived-open": issue("todo"),
        "archived-shipped": issue("shipped", true),
        "after-archived-shipped": issue("todo"),
        "legacy-archived": legacy("open", true),
        "legacy-after-archived": legacy("open"),
      },
      edges: [
        ["archived-open", "after-archived-open"],
        ["archived-shipped", "after-archived-shipped"],
        ["legacy-archived", "legacy-after-archived"],
      ],
      // Archival never substitutes for success on managed work.
      blocked: ["after-archived-open"],
    },
    "terminal and archived candidates": {
      tasks: {
        open: issue("todo"),
        shipped: issue("shipped"),
        aborted: issue("aborted"),
        archived: issue("todo", true),
        "legacy-open": legacy("open"),
        "legacy-closed": legacy("closed"),
      },
      edges: [
        ["open", "shipped"],
        ["open", "aborted"],
        ["open", "archived"],
        ["legacy-open", "legacy-closed"],
      ],
      blocked: [],
    },
    "a pending gate": {
      tasks: {
        gated: issue("todo"),
        "gated-by-id": issue("todo"),
        satisfied: issue("shipped"),
        "gated-after-satisfied": issue("todo"),
        open: issue("todo"),
        "gated-after-open": issue("todo"),
      },
      edges: [
        ["satisfied", "gated-after-satisfied"],
        ["open", "gated-after-open"],
      ],
      gates: [
        "issue:gated",
        "gated-by-id",
        "issue:gated-after-satisfied",
        "issue:gated-after-open",
      ],
      blocked: ["gated-after-open"],
    },
  };

  function snapshotOf(scenario: Scenario): ReadinessSnapshot {
    const { db, rawDb } = createTestDb();
    try {
      applySchema(db, lifecycleDefinition, "test");
      for (const [id, { type, state, archived }] of Object.entries(
        scenario.tasks,
      )) {
        create(
          db,
          {
            id,
            type,
            data: type === "issue" ? { phase: state } : { status: state },
            created_by: "test",
          },
          1,
          readinessOrigin,
        );
        if (archived)
          db.update(schema.entities)
            .set({ archived: 1 })
            .where(eq(schema.entities.id, id))
            .run();
      }
      for (const [from_id, to_id, type = "blocks"] of scenario.edges ?? [])
        db.insert(schema.entityRelationships)
          .values({ from_id, to_id, type, created_at: 1, schema_version: 1 })
          .run();
      for (const resource of scenario.gates ?? [])
        db.insert(schema.gates)
          .values({
            id: `gate-${resource}`,
            resource,
            timeout_at: null,
            await_type: "human",
            fence: 1,
            created_at: 1,
            created_by: "test",
          })
          .run();
      const snapshot = readReadinessSnapshot(db);
      for (const id of scenario.dropped ?? []) snapshot.entities.delete(id);
      return snapshot;
    } finally {
      rawDb.close();
    }
  }
  const sorted = (ids: Set<string>) => [...ids].sort();

  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`agrees with evaluateReadiness for ${name}`, () => {
      const snapshot = snapshotOf(scenario);
      const blocked = sorted(blockedTaskIds(snapshot));
      expect(blocked).toEqual(blockedByReadiness(snapshot));
      expect(blocked).toEqual(scenario.blocked.slice().sort());
    });
  }

  it("agrees with evaluateReadiness for the shared readiness fixture", () => {
    const expected = [
      "archived-dependent",
      "blocked",
      "cycle-a",
      "cycle-b",
      "missing",
      "soft",
    ];
    const snapshot = readReadinessSnapshot(fixture.db);
    expect(sorted(blockedTaskIds(snapshot))).toEqual(expected);
    expect(sorted(blockedTaskIds(snapshot))).toEqual(
      blockedByReadiness(snapshot),
    );
    // A missing predecessor still blocks managed work.
    snapshot.entities.delete("absent");
    expect(sorted(blockedTaskIds(snapshot))).toEqual(expected);
    expect(sorted(blockedTaskIds(snapshot))).toEqual(
      blockedByReadiness(snapshot),
    );
  });

  it("excludes terminal and archived tasks even when a prerequisite is unresolved", () => {
    const snapshot = snapshotOf(scenarios["terminal and archived candidates"]);
    for (const [id, predecessor] of [
      ["shipped", "open"],
      ["aborted", "open"],
      ["archived", "open"],
      ["legacy-closed", "legacy-open"],
    ])
      expect(evaluateReadiness(snapshot, id).reasons).toContainEqual(
        expect.objectContaining({
          code: "dependency-unsatisfied",
          resource: predecessor,
        }),
      );
    expect(blockedTaskIds(snapshot).size).toBe(0);
    const entity = (id: string) => {
      const found = snapshot.entities.get(id);
      if (!found) throw new Error(`missing ${id}`);
      return found;
    };
    expect(isTerminal(snapshot, entity("shipped"))).toBe(true);
    expect(isTerminal(snapshot, entity("aborted"))).toBe(true);
    expect(isTerminal(snapshot, entity("legacy-closed"))).toBe(true);
    expect(isTerminal(snapshot, entity("archived"))).toBe(false);
    expect(isTerminal(snapshot, entity("legacy-open"))).toBe(false);
  });

  it("does not count a pending gate as a prerequisite", () => {
    const snapshot = snapshotOf(scenarios["a pending gate"]);
    for (const id of ["gated", "gated-by-id", "gated-after-satisfied"]) {
      expect(evaluateReadiness(snapshot, id).reasons).toContainEqual(
        expect.objectContaining({ code: "gate-pending" }),
      );
      expect(blockedTaskIds(snapshot).has(id)).toBe(false);
    }
    expect(blockedTaskIds(snapshot).has("gated-after-open")).toBe(true);
  });

  it("does not block legacy work behind a closed legacy predecessor", () => {
    const snapshot = snapshotOf(scenarios["mixed lifecycle and legacy tasks"]);
    const blocked = blockedTaskIds(snapshot);
    expect(blocked.has("legacy-after-legacy-closed")).toBe(false);
    expect(blocked.has("legacy-after-legacy-open")).toBe(true);
    // Managed work never guesses that a legacy predecessor succeeded.
    expect(blocked.has("managed-after-legacy-closed")).toBe(true);
    expect(
      evaluateReadiness(snapshot, "managed-after-legacy-closed").reasons,
    ).toContainEqual({
      code: "dependency-lifecycle-unconfigured",
      resource: "legacy-closed",
    });
  });

  it("counts a cycle among successful predecessors on its own", () => {
    const snapshot = snapshotOf(
      scenarios["a cycle between lifecycle-configured tasks"],
    );
    expect(
      evaluateReadiness(snapshot, "after-shipped-cycle").reasons.map(
        (reason) => reason.code,
      ),
    ).toEqual(["dependency-cycle"]);
    expect(blockedTaskIds(snapshot).has("after-shipped-cycle")).toBe(true);
  });
});
