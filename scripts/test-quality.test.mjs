import assert from "node:assert/strict";
import test from "node:test";
import { checkRuntimeReport } from "./check-runtime-report.mjs";
import { inspectTest } from "./check-test-quality.mjs";

test("placeholder and runtime skip guards reject false greens", () => {
  assert.equal(inspectTest("expect(true).toBe(true)").length, 1);
  assert.deepEqual(inspectTest("expect(response.ok).toBe(true)"), []);
  assert.equal(inspectTest("it.todo('coverage')", true).length, 1);
  assert.deepEqual(inspectTest("it.todo('coverage')"), []);
  const report = (status) => ({
    success: true,
    numPassedTests: 1,
    numTotalTests: 1,
    testResults: [{ assertionResults: [{ fullName: "required", status }] }],
  });
  checkRuntimeReport(report("passed"));
  for (const status of ["pending", "todo", "skipped", "failed"])
    assert.throws(() => checkRuntimeReport(report(status)));
  assert.throws(() => checkRuntimeReport({ success: true, testResults: [] }));
});
