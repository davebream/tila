import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const gate = (needs, required = ["verify", "secrets"]) =>
  spawnSync("bash", ["scripts/ci-gate.sh"], {
    env: {
      ...process.env,
      NEEDS_JSON: JSON.stringify(needs),
      REQUIRED_JOBS: JSON.stringify(required),
    },
  }).status;

test("CI gate accepts all required successes", () => {
  assert.equal(
    gate({ verify: { result: "success" }, secrets: { result: "success" } }),
    0,
  );
});
test("CI gate rejects missing, failed, cancelled and skipped dependencies", () => {
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.notEqual(
      gate({ verify: { result }, secrets: { result: "success" } }),
      0,
    );
  }
  assert.notEqual(gate({}), 0);
  assert.notEqual(gate({}, []), 0);
  assert.notEqual(
    gate({ verify: { result: "success" }, secrets: { result: "success" } }, [
      "verify",
      "secrets",
      "runtime",
    ]),
    0,
  );
});

test("scope uploads must succeed when required, but can be skipped on unprivileged events", () => {
  const needs = {
    verify: { result: "success" },
    secrets: { result: "success" },
  };
  for (const result of ["failure", "cancelled", "skipped", undefined])
    assert.notEqual(
      gate({ ...needs, scopes: { result } }, ["verify", "secrets", "scopes"]),
      0,
    );
  assert.equal(
    gate({ ...needs, scopes: { result: "success" } }, [
      "verify",
      "secrets",
      "scopes",
    ]),
    0,
  );
  assert.equal(gate({ ...needs, scopes: { result: "skipped" } }), 0);
});
