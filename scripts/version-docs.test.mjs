/**
 * version-docs.test.mjs
 *
 * Lint-protection: install/usage version strings in README.md and
 * docs/tutorial-getting-started.md must match the current product version
 * (read from root package.json).
 *
 * Explicit ignore list (these legitimately carry historical or range versions):
 *   - CHANGELOG.md (entirely — historical headings)
 *   - SECURITY.md Supported Versions rows (x-ranges like "0.2.x")
 *   - Dependency version ranges (>=, <, ~, ^, x-ranges)
 *   - "see latest release" link form
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readRel(rel) {
  return readFile(join(repoRoot, rel), "utf8");
}

/**
 * Extract install/usage version literals from a document.
 *
 * Only flags vX.Y.Z literals that appear in clear install/usage contexts:
 *   - With an explicit "v" prefix (v0.2.7) — product version pin
 *   - After "Status:" annotations
 *   - After "current:" annotations
 *
 * Ignores:
 *   - Bare X.Y.Z without a "v" prefix (may be JSON data values, dependency
 *     ranges, or arbitrary version fields in example output)
 *   - x-ranges (0.2.x style)
 *   - Dependency version ranges (>=, <=, <, ~, ^)
 *   - "see latest release" link forms (/releases/latest)
 *   - Download URL tags (/releases/download/vX.Y.Z/)
 */
function extractVersionLiterals(content) {
  // Only match explicit "v" prefixed versions (vX.Y.Z) — bare X.Y.Z are too
  // likely to be JSON data values or library version examples.
  const re = /\bv(\d+\.\d+\.\d+)\b/g;
  const results = [];
  for (const m of content.matchAll(re)) {
    const raw = m[0];
    const start = m.index;
    const version = m[1];

    // Skip x-ranges: e.g. v0.2.x
    if (content.slice(start + raw.length, start + raw.length + 2) === ".x") {
      continue;
    }

    // Skip if preceded by a range operator (>=, <=, <, >, ~, ^)
    const before = content.slice(Math.max(0, start - 3), start);
    if (/[>=<!~^]/.test(before)) {
      continue;
    }

    // Skip "see latest release" link forms (/releases/latest)
    const context = content.slice(
      Math.max(0, start - 60),
      start + raw.length + 30,
    );
    if (/releases\/latest/i.test(context)) {
      continue;
    }

    // Skip if inside a URL tag (e.g. download/vX.Y.Z/file or compare/vX.Y.Z)
    if (/releases\/download\/v|compare\/v|releases\/tag\/v/.test(context)) {
      continue;
    }

    results.push({ version, raw, index: start, context: context.trim() });
  }
  return results;
}

test("README.md install/usage version strings match product version", async () => {
  const pkg = JSON.parse(await readRel("package.json"));
  const productVersion = pkg.version;
  const content = await readRel("README.md");

  const literals = extractVersionLiterals(content);
  const stale = literals.filter((l) => l.version !== productVersion);

  assert.equal(
    stale.length,
    0,
    `README.md has ${stale.length} stale version literal(s) (expected ${productVersion}):\n${stale.map((l) => `  "${l.raw}" at context: ...${l.context}...`).join("\n")}`,
  );
});

test("docs/tutorial-getting-started.md install/usage version strings match product version", async () => {
  const pkg = JSON.parse(await readRel("package.json"));
  const productVersion = pkg.version;
  const content = await readRel("docs/tutorial-getting-started.md");

  const literals = extractVersionLiterals(content);
  const stale = literals.filter((l) => l.version !== productVersion);

  assert.equal(
    stale.length,
    0,
    `docs/tutorial-getting-started.md has ${stale.length} stale version literal(s) (expected ${productVersion}):\n${stale.map((l) => `  "${l.raw}" at context: ...${l.context}...`).join("\n")}`,
  );
});

test("SECURITY.md Supported Versions includes 0.2.x (not just 0.1.x)", async () => {
  const content = await readRel("SECURITY.md");
  assert.match(
    content,
    /0\.2\.x.*Yes|Yes.*0\.2\.x/i,
    "SECURITY.md Supported Versions must include 0.2.x as supported",
  );
  assert.doesNotMatch(
    content,
    /^\|\s*0\.1\.x\s*\|\s*Yes\s*\|/m,
    "SECURITY.md Supported Versions must not list 0.1.x as supported (it is superseded)",
  );
});
