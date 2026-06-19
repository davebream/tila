/**
 * changelog.test.mjs
 *
 * Assert CHANGELOG.md has a heading for every git-tagged release
 * matching ^v\d+\.\d+\.\d+$ (strip the "v" prefix for the heading check).
 *
 * The canonical "published version" signal in this repo is git tags.
 * The test asserts heading presence (not richness of content).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function getGitTags(repoPath) {
  const result = spawnSync("git", ["tag", "-l", "v*"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git tag -l failed: ${result.stderr}`);
  }
  return result.stdout
    .trim()
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1)); // strip the "v" prefix
}

test("CHANGELOG.md has a heading for every git-tagged release", async () => {
  const versions = getGitTags(repoRoot);
  const content = await readFile(join(repoRoot, "CHANGELOG.md"), "utf8");

  const missingVersions = versions.filter(
    (v) => !content.includes(`## [${v}]`),
  );

  assert.equal(
    missingVersions.length,
    0,
    `CHANGELOG.md is missing headings for ${missingVersions.length} tagged release(s):\n${missingVersions.map((v) => `  ## [${v}]`).join("\n")}\nAdd these entries (even a one-line "no user-facing changes" note is sufficient).`,
  );
});

test("CHANGELOG.md trailing compare links point to current product version", async () => {
  const content = await readFile(join(repoRoot, "CHANGELOG.md"), "utf8");
  // The [Unreleased] compare link must reference the latest tag (not v0.1.0)
  const unreleasedMatch = content.match(/\[Unreleased\]:\s*(\S+)/);
  assert.ok(
    unreleasedMatch,
    "CHANGELOG.md must have an [Unreleased] compare link",
  );
  // Must not compare from v0.1.0 when newer tags exist
  assert.doesNotMatch(
    unreleasedMatch[1],
    /compare\/v0\.1\.0\.\.\.HEAD/,
    "[Unreleased] compare link must not compare from v0.1.0 — update to the latest tag",
  );
});
