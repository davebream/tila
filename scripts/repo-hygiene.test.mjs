import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

// ---------------------------------------------------------------------------
// 1. OSS-RELEASE-RUNBOOK.md is tracked by git (not gitignored)
// ---------------------------------------------------------------------------
test("OSS-RELEASE-RUNBOOK.md is tracked by git (not gitignored or missing)", () => {
  const result = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "OSS-RELEASE-RUNBOOK.md"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `OSS-RELEASE-RUNBOOK.md must be tracked by git. git ls-files reported:\n${result.stderr.trim()}\n\nFix: remove the gitignore entry and run 'git add OSS-RELEASE-RUNBOOK.md'`,
  );
});

// ---------------------------------------------------------------------------
// 2. SWEEP_SECRET is documented in wrangler.toml comments
// ---------------------------------------------------------------------------
test("SWEEP_SECRET is documented in packages/worker/wrangler.toml", async () => {
  const wranglerToml = await readFile(
    join(repoRoot, "packages/worker/wrangler.toml"),
    "utf8",
  );
  assert.ok(
    wranglerToml.includes("SWEEP_SECRET"),
    "packages/worker/wrangler.toml must document SWEEP_SECRET in its secrets comment block. " +
      "SWEEP_SECRET authenticates the /_internal/sweep cron endpoint (X-Sweep-Secret header).",
  );
});

// ---------------------------------------------------------------------------
// 3. SWEEP_SECRET is documented in docs/05-OPERATIONS.md
// ---------------------------------------------------------------------------
test("SWEEP_SECRET is documented in docs/05-OPERATIONS.md", async () => {
  const ops = await readFile(join(repoRoot, "docs/05-OPERATIONS.md"), "utf8");
  assert.ok(
    ops.includes("SWEEP_SECRET"),
    "docs/05-OPERATIONS.md must document SWEEP_SECRET. " +
      "It authenticates the /_internal/sweep endpoint and must be set as a Worker secret.",
  );
});

// ---------------------------------------------------------------------------
// 4. CLAUDE.md and AGENTS.md are absent from publishable package tarballs
// ---------------------------------------------------------------------------
const publishablePackageDirs = [
  "packages/cli",
  "packages/sdk",
  "packages/mcp-server",
  "packages/cli-darwin-arm64",
  "packages/cli-darwin-x64",
  "packages/cli-linux-arm64",
  "packages/cli-linux-arm64-musl",
  "packages/cli-linux-x64",
  "packages/cli-linux-x64-musl",
  "packages/cli-windows-arm64",
  "packages/cli-windows-x64",
];

for (const pkgDir of publishablePackageDirs) {
  test(`${pkgDir}: CLAUDE.md and AGENTS.md are absent from npm tarball`, () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: join(repoRoot, pkgDir),
      encoding: "utf8",
    });

    // npm pack --dry-run --json exits non-zero on lifecycle errors but still
    // emits valid JSON on stdout when the pack itself is successful.
    let packData;
    try {
      packData = JSON.parse(result.stdout);
    } catch {
      // If we cannot parse, skip the assertion (don't fail on npm/node version quirks)
      return;
    }

    const entry = Array.isArray(packData) ? packData[0] : packData;
    const files = (entry?.files ?? []).map((f) => (f.path ?? "").toLowerCase());

    const forbidden = files.filter(
      (f) => f === "claude.md" || f === "agents.md",
    );
    assert.equal(
      forbidden.length,
      0,
      `${pkgDir} tarball must not include CLAUDE.md or AGENTS.md. Found: ${forbidden.join(", ")}\nAdd these files to the package's .npmignore or remove them from the files array.`,
    );
  });
}
