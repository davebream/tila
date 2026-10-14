import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { publishReports } from "./issue-308-publish.mjs";
import { checks, runChecks, verifyArtifacts } from "./issue-308-scenarios.mjs";

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
  migrations: {
    scope: "local fixture",
    ...Object.fromEntries(
      ["do", "d1", "configuration"].map((g) => [
        g,
        [{ path: `fixture/${g}`, sha256: "c".repeat(64) }],
      ]),
    ),
  },
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("sanitizes historical failed JSON copies, preserves local bytes and links both checksums", async () => {
  const base = mkdtempSync(resolve(tmpdir(), "tila-publication-"));
  try {
    const selected = [checks[0]];
    const first = await runChecks({
      base,
      output: "local",
      context,
      selected,
      run: async () => ({ code: 1, log: "historical failure" }),
    });
    const observation = first.report.observations[0];
    const originalPath = observation.artifact_refs[0].path;
    const original = Buffer.from(
      JSON.stringify({
        message: "historical failure",
        stack: "home/example/private/runtime.js",
        name: "/Users/example/private/source.ts",
      }),
    );
    // Model an older producer which stored a slashless path before this fix.
    writeFileSync(resolve(base, originalPath), original);
    observation.artifact_refs[0].sha256 = hash(original);
    writeFileSync(resolve(base, first.path), JSON.stringify(first.report));
    const originalManifest = readFileSync(resolve(base, first.path));
    const originalLedger = readFileSync(
      resolve(base, first.path, "../observations.jsonl"),
    );
    const next = await runChecks({
      base,
      output: "local",
      context,
      selected,
      run: async () => ({ code: 0, log: "green rerun" }),
    });
    const publication = publishReports({
      base,
      reportPaths: [first.path, next.path],
      expectedChecks: selected,
    });
    verifyArtifacts(publication, base);
    const published = publication.observations[0].artifact_refs[0];
    assert.equal(published.source_artifact_sha256, hash(original));
    assert.notEqual(published.sha256, published.source_artifact_sha256);
    const copy = readFileSync(resolve(base, published.path));
    assert.equal(published.sha256, hash(copy));
    assert.ok(
      !copy.includes("home/example") && !copy.includes("Users/example"),
    );
    assert.equal(JSON.parse(copy).message, "historical failure");
    assert.deepEqual(readFileSync(resolve(base, originalPath)), original);
    assert.deepEqual(readFileSync(resolve(base, first.path)), originalManifest);
    assert.deepEqual(
      readFileSync(resolve(base, first.path, "../observations.jsonl")),
      originalLedger,
    );
    assert.equal(publication.observations[0].result, "failed");
    assert.deepEqual(
      publication.observations[0].timestamps,
      observation.timestamps,
    );
    assert.equal(publication.final_green.candidate_sha, context.candidate_sha);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("rejects tampered local source artifacts before publication", async () => {
  const base = mkdtempSync(resolve(tmpdir(), "tila-publication-"));
  try {
    const result = await runChecks({
      base,
      output: "local",
      context,
      selected: [checks[0]],
      run: async () => ({ code: 0, log: "fixture" }),
    });
    writeFileSync(
      resolve(base, result.report.observations[0].artifact_refs[0].path),
      "tampered",
    );
    assert.throws(
      () =>
        publishReports({
          base,
          reportPaths: [result.path],
          expectedChecks: [checks[0]],
        }),
      /Checksum mismatch/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
