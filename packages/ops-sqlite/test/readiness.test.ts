import { readFileSync } from "node:fs";
import { parseTilaSchemaToml } from "@tila/core";
import { TilaSchemaTomlSchema } from "@tila/schemas";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquire } from "../src/coordination-ops";
import { create, get, update } from "../src/entity-ops";
import { GateBlockedError } from "../src/gate-ops";
import {
  computeReadyEntities,
  evaluateReadiness,
  readReadinessSnapshot,
} from "../src/ready-ops";
import * as schema from "../src/schema";
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
