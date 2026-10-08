import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("diagnostics retain output and preserve a failed command's exit status", () => {
  const dir = mkdtempSync(join(tmpdir(), "tila-ci-report-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/ci-run.mjs",
        "fixture",
        process.execPath,
        "-e",
        'console.log("fixture output"); process.exit(7)',
      ],
      {
        env: {
          ...process.env,
          CI_REPORT_DIR: dir,
          GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        },
      },
    );
    assert.equal(result.status, 7);
    assert.match(
      readFileSync(join(dir, "fixture.log"), "utf8"),
      /fixture output/,
    );
    const timing = JSON.parse(readFileSync(join(dir, "timings.jsonl"), "utf8"));
    assert.equal(timing.exitCode, 7);
    assert.ok(timing.seconds >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
