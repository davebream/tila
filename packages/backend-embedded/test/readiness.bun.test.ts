import { expect, test } from "bun:test";
import { readyOps } from "@tila/ops-sqlite";
import {
  expectedReadyIds,
  seedReadinessFixture,
} from "../../ops-sqlite/test/readiness-fixture";
import { makeHarness } from "./harness.bun";

test("Bun uses the same lifecycle and dependency readiness contract as Node", () => {
  const harness = makeHarness();
  try {
    seedReadinessFixture(harness.db);
    expect(
      readyOps
        .computeReadyEntities(harness.db)
        .map((entity) => entity.id)
        .sort(),
    ).toEqual(expectedReadyIds);
    expect(
      readyOps
        .evaluateReadiness(
          readyOps.readReadinessSnapshot(harness.db),
          "cycle-a",
          true,
        )
        .reasons.some((reason) => reason.code === "dependency-cycle"),
    ).toBe(true);
  } finally {
    harness.close();
  }
});
