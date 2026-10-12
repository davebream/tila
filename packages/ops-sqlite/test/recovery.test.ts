import { afterEach, beforeEach, it } from "vitest";
import { type TestDb, createTestDb } from "./helpers";
import { recoveryScenarios } from "./recovery-scenarios";
let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
});
afterEach(() => fixture.rawDb.close());
for (const scenario of recoveryScenarios)
  it(scenario.name, () => scenario.run(fixture.db));
