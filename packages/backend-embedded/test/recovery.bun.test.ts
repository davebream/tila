import { test } from "bun:test";
import { recoveryScenarios } from "../../ops-sqlite/test/recovery-scenarios";
import { makeHarness } from "./harness.bun";
for (const scenario of recoveryScenarios)
  test(scenario.name, () => {
    const harness = makeHarness();
    try {
      scenario.run(harness.db);
    } finally {
      harness.close();
    }
  });
