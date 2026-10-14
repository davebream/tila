import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  checks,
  runChecks,
  sanitize,
  sourceFingerprint,
  validateObservation,
  verifyArtifacts,
} from "./issue-308-scenarios.mjs";

test("source fingerprint hashes directory symlinks without traversing them and excludes evidence", () => {
  const base = mkdtempSync(resolve(tmpdir(), "tila-source-"));
  try {
    mkdirSync(resolve(base, "fixture-dir"));
    symlinkSync("fixture-dir", resolve(base, "link"));
    writeFileSync(resolve(base, "source.ts"), "fixture source");
    const fingerprint = sourceFingerprint(["source.ts", "link"], base);
    writeFileSync(resolve(base, "fixture-dir/ignored"), "not tracked");
    assert.equal(
      sourceFingerprint(
        ["link", "docs/evidence/not-read.json", "source.ts"],
        base,
      ),
      fingerprint,
    );
    writeFileSync(resolve(base, "source.ts"), "changed source");
    assert.notEqual(
      sourceFingerprint(["source.ts", "link"], base),
      fingerprint,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const context = {
  candidate_sha: "a".repeat(40),
  source_sha256: "b".repeat(64),
  release: "0.9.0",
  environment: {
    os: "linux",
    arch: "x64",
    node: "test",
    pnpm: "test",
    profiles: "synthetic",
    runtime_versions: { workerd: "test" },
  },
  migrations: Object.fromEntries(
    ["do", "d1", "configuration"]
      .map((g) => [g, [{ path: `fixture/${g}`, sha256: "c".repeat(64) }]])
      .concat([["scope", "local fixture"]]),
  ),
};

test("redacts private paths and credentials while retaining product failure diagnostics", () => {
  const output = sanitize(
    "FAIL packages/ui/test/pages/overview.test.tsx\n/home/example/private/records/record.json\nBearer test-secret\napi_key=example-secret\ntila_s.example.jwt\n/home/example/code/project/src.ts",
    "/home/example/code/project",
  );
  assert.ok(output.includes("FAIL packages/ui/test/pages/overview.test.tsx"));
  for (const secret of [
    "/home/",
    "/private/records",
    "test-secret",
    "example-secret",
    "example.jwt",
  ])
    assert.ok(!output.includes(secret));
  assert.ok(output.includes("<checkout>/src.ts"));
});

test("redacts slashless source-map paths in runtime JSON and checksums sanitized copies", async () => {
  const base = mkdtempSync(resolve(tmpdir(), "tila-slashless-"));
  try {
    const source = {
      stack:
        "at home/example/code/project/node_modules/pkg/index.js:4\nfile://home/example/code/project/src.ts\nUsers/example/private/log",
      name: "/home/example/code/project/packages/ui/test/pages/overview.test.tsx",
    };
    const sanitized = JSON.parse(
      JSON.stringify(source, (_key, value) =>
        typeof value === "string"
          ? sanitize(value, "/home/example/code/project")
          : value,
      ),
    );
    assert.ok(!JSON.stringify(sanitized).includes("home/example"));
    assert.ok(!JSON.stringify(sanitized).includes("Users/example"));
    assert.ok(
      sanitized.stack.includes("<checkout>/node_modules/pkg/index.js:4"),
    );
    assert.ok(
      sanitized.name.includes("packages/ui/test/pages/overview.test.tsx"),
    );
    mkdirSync(resolve(base, ".ci-reports"));
    const result = await runChecks({
      base,
      output: "evidence",
      context,
      selected: [{ ...checks[0], provenance: "local Cloudflare runtime" }],
      run: async () => {
        writeFileSync(
          resolve(base, ".ci-reports/runtime.json"),
          JSON.stringify({
            startTime: Date.now(),
            success: true,
            testResults: [source],
          }),
        );
        return { code: 0, log: source.stack };
      },
    });
    verifyArtifacts(result.report, base);
    const ref = result.report.observations[0].artifact_refs.find((r) =>
      r.path.endsWith(".runtime.json"),
    );
    assert.ok(ref, "Runtime JSON must be retained separately");
    const retained = JSON.parse(readFileSync(resolve(base, ref.path), "utf8"));
    assert.ok(!JSON.stringify(retained).includes("home/example"));
    assert.ok(!JSON.stringify(retained).includes("Users/example"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("retains failed commands, continues, links reruns and detects artifact tampering", async () => {
  const base = mkdtempSync(resolve(tmpdir(), "tila-scenarios-"));
  try {
    const selected = checks.slice(0, 2);
    let executions = 0;
    const first = await runChecks({
      base,
      output: "evidence",
      context,
      selected,
      run: async () => ({
        code: executions++ === 0 ? 1 : 0,
        log: "fixture diagnostic",
      }),
    });
    assert.equal(executions, 2);
    assert.equal(first.failed, true);
    assert.deepEqual(
      first.report.observations.map((o) => o.result),
      ["failed", "passed", "blocked", "blocked", "blocked"],
    );
    const originalBytes = readFileSync(resolve(base, first.path));
    const second = await runChecks({
      base,
      output: "evidence",
      context,
      selected,
      previous: {
        path: first.path,
        bytes: originalBytes,
        report: first.report,
      },
      run: async () => ({ code: 0, log: "rerun diagnostic" }),
    });
    assert.equal(second.failed, false);
    assert.notEqual(first.path, second.path);
    assert.deepEqual(readFileSync(resolve(base, first.path)), originalBytes);
    assert.deepEqual(second.report.observations[0].rerun_of, [
      first.report.observations[0].id,
    ]);
    const ledger = readFileSync(
      resolve(base, second.path, "../observations.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(ledger, second.report.observations);
    verifyArtifacts(first.report, base);
    const observation = first.report.observations[0];
    for (const field of [
      "candidate_sha",
      "environment",
      "migrations",
      "blocker_owner",
      "artifact_refs",
      "timestamps",
    ])
      assert.throws(() => {
        const bad = { ...observation };
        delete bad[field];
        validateObservation(bad);
      }, /Missing/);
    assert.throws(
      () =>
        validateObservation({
          ...observation,
          provenance: "fixture-success-is-live",
        }),
      /provenance/,
    );
    assert.throws(() =>
      validateObservation({
        ...observation,
        result: "failed",
        blocker_owner: null,
      }),
    );
    assert.throws(
      () =>
        validateObservation({
          ...observation,
          artifact_refs: [{ path: "../private", sha256: "d".repeat(64) }],
        }),
      /relative/,
    );
    assert.throws(() =>
      validateObservation({
        ...observation,
        measurements: {
          ...observation.measurements,
          recovery_ms: "unobserved success",
        },
      }),
    );
    validateObservation({
      ...observation,
      timestamps: {
        started_at: null,
        finished_at: null,
        recorded_at: new Date().toISOString(),
        limitation: "Execution times not captured for retained diagnostic",
      },
    });
    writeFileSync(resolve(base, observation.artifact_refs[0].path), "changed");
    assert.throws(
      () => verifyArtifacts(first.report, base),
      /Checksum mismatch/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("missing executable is a failed observation with metadata and a retained log", async () => {
  const base = mkdtempSync(resolve(tmpdir(), "tila-scenarios-"));
  try {
    const result = await runChecks({
      base,
      output: "evidence",
      context,
      selected: [checks[0]],
      run: async () => {
        throw new Error("ENOENT test dependency unavailable");
      },
    });
    assert.equal(result.failed, true);
    assert.match(
      readFileSync(
        resolve(base, result.report.observations[0].artifact_refs[0].path),
        "utf8",
      ),
      /ENOENT/,
    );
    validateObservation(result.report.observations[0]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
