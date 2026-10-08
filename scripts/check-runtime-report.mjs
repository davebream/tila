import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function checkRuntimeReport(report) {
  assert.equal(report.success, true, "Runtime suite must succeed");
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.ok(cases.length > 0, "Runtime suite must execute tests");
  for (const result of cases)
    assert.equal(
      result.status,
      "passed",
      `Required runtime case did not pass: ${result.fullName}`,
    );
  assert.equal(report.numPassedTests, cases.length);
  assert.equal(report.numTotalTests, cases.length);
}
if (process.argv[1]?.endsWith("check-runtime-report.mjs"))
  checkRuntimeReport(
    JSON.parse(
      readFileSync(process.argv[2] || ".ci-reports/runtime.json", "utf8"),
    ),
  );
