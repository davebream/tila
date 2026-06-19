/**
 * docs-rename.test.mjs
 *
 * Lint-protection for the entities→tasks rename across consumer docs.
 * Asserts that tracked consumer docs do not present deprecated terminology
 * as canonical, list phantom CLI commands, or contain stale "not published" claims.
 *
 * Per-commit-green invariant: this file and its fixes are committed together.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read a file relative to the repo root. */
async function read(rel) {
  return readFile(join(repoRoot, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Task 3: Rename propagation lint
// ---------------------------------------------------------------------------

test("CLI README: no 'not published to npm yet' claim", async () => {
  const content = await read("packages/cli/README.md");
  assert.doesNotMatch(
    content,
    /not published to npm yet/i,
    "packages/cli/README.md must not claim the CLI is not published — tila-cli@0.2.7 is published",
  );
});

test("CLI README: no phantom 'destroy' top-level command", async () => {
  const content = await read("packages/cli/README.md");
  // Match 'destroy' only when it appears as a standalone command row in a table
  // e.g. `| \`destroy\`` or `| destroy |`. Legitimate internal use in prose is fine.
  const phantomRow = /^\|\s*`destroy`\s*\|/m;
  assert.doesNotMatch(
    content,
    phantomRow,
    "packages/cli/README.md must not list `destroy` as a top-level CLI command — it is not a real Citty command",
  );
});

test("CLI README: no phantom 'migrate' top-level command", async () => {
  const content = await read("packages/cli/README.md");
  const phantomRow = /^\|\s*`migrate`\s*\|/m;
  assert.doesNotMatch(
    content,
    phantomRow,
    "packages/cli/README.md must not list `migrate` as a top-level CLI command — it is not a real Citty command",
  );
});

test("CLI README: work-unit and entity marked deprecated for task", async () => {
  const content = await read("packages/cli/README.md");
  // Both work-unit AND entity must be marked deprecated; neither can be 'canonical'
  assert.doesNotMatch(
    content,
    /work-unit.*canonical.*public alias|work-unit.*canonical/i,
    "packages/cli/README.md must not present work-unit as the canonical public alias",
  );
  // entity should not be presented as deprecated in favor of work-unit (stale circular)
  assert.doesNotMatch(
    content,
    /deprecated.*prefer.*work-unit\b/i,
    "packages/cli/README.md must not recommend work-unit (which is itself deprecated) — use task",
  );
});

test("SURFACE-PARITY: no 'tila entity show' guidance", async () => {
  const content = await read("docs/09-SURFACE-PARITY.md");
  assert.doesNotMatch(
    content,
    /tila entity show/,
    "docs/09-SURFACE-PARITY.md must not recommend `tila entity show` — use `tila task show`",
  );
});

test("SURFACE-PARITY: entity/work-unit not presented as canonical resource type", async () => {
  const content = await read("docs/09-SURFACE-PARITY.md");
  // Must not label entity/work-unit as canonical resource name in the matrix heading
  // Legitimate "entity" mentions for the internal-table context are allowed
  assert.doesNotMatch(
    content,
    /^##\s.*Work [Uu]nit/m,
    "docs/09-SURFACE-PARITY.md must not have a 'Work Unit' section heading — use Task",
  );
  // Check that canonical resource is 'task' in the capability matrix
  // (Work unit rows may exist if properly deprecated; but the surface-parity matrix
  //  uses 'Entity create / Entity list' language that should become 'Task create / Task list')
  // The test allows 'work unit' in a note/deprecated context — only flags it in the main
  // capability column where 'work unit (all of above) | Y |...' presents it as canonical.
  assert.doesNotMatch(
    content,
    /\|\s*Work unit\s*\(all of above\)/i,
    "docs/09-SURFACE-PARITY.md must not list 'Work unit (all of above)' as a capability row — task is canonical",
  );
});

test("SDK README: Quick Start leads with createTila().tasks.* not createEntityMethods", async () => {
  const content = await read("packages/sdk/README.md");
  // The Quick Start section should use createTila().tasks.* first, not createEntityMethods
  const quickStartIdx = content.indexOf("## Quick Start");
  assert.ok(
    quickStartIdx >= 0,
    "packages/sdk/README.md must have a '## Quick Start' section",
  );

  const afterQuickStart = content.slice(quickStartIdx, quickStartIdx + 400);
  // createEntityMethods should not be the first code example in Quick Start
  const entityMethodsIdx = afterQuickStart.indexOf("createEntityMethods");
  const createTilaIdx = afterQuickStart.indexOf("createTila");
  assert.ok(
    createTilaIdx >= 0 &&
      (entityMethodsIdx < 0 || createTilaIdx < entityMethodsIdx),
    "packages/sdk/README.md Quick Start must lead with createTila() before or instead of createEntityMethods",
  );
});

test("CLI index.ts: entity deprecation comment points to task (not work-unit)", async () => {
  const content = await read("packages/cli/src/index.ts");
  // entity line should mention 'task' as the canonical target, not 'work-unit'
  const entityLineMatch =
    content.match(/entity.*deprecated.*\n?.*prefer/i) ??
    content.match(/@deprecated.*entity.*\n?.*prefer/i);
  if (entityLineMatch) {
    // If there's a deprecation comment for entity, it must not say "prefer work-unit"
    assert.doesNotMatch(
      entityLineMatch[0],
      /prefer.*work-unit/i,
      "packages/cli/src/index.ts entity deprecation comment must not say 'prefer work-unit' — task is canonical",
    );
  }
  // Also check the comment around line 24 directly
  assert.doesNotMatch(
    content,
    /prefer "work-unit" for new usage/i,
    "packages/cli/src/index.ts must not recommend work-unit in deprecation comments",
  );
});

test("ARCHITECTURE: CLI dependency graph note is accurate (not misstating CLI as standalone)", async () => {
  const content = await read("docs/02-ARCHITECTURE.md");
  // The architecture doc must not claim CLI is standalone/imports schemas only
  // when it actually imports from tila-sdk
  assert.doesNotMatch(
    content,
    /cli\s*\(standalone.*imports schemas only\)/i,
    "docs/02-ARCHITECTURE.md must not describe CLI as 'standalone, imports schemas only' — CLI uses tila-sdk",
  );
});

// ---------------------------------------------------------------------------
// Task 8: Backfill-wording lint (extended in phase 5)
// ---------------------------------------------------------------------------

test("ROADMAP: no 'auto-applied with default backfill' wording for required-field-with-default", async () => {
  const content = await read("docs/03-ROADMAP.md");
  assert.doesNotMatch(
    content,
    /auto-applied with default backfill/i,
    "docs/03-ROADMAP.md §4.1 criterion 6 must use lazy read-time defaulting language, not 'auto-applied with default backfill'",
  );
});

test("ROADMAP: schema default wording references lazy read-time materialization", async () => {
  const content = await read("docs/03-ROADMAP.md");
  assert.match(
    content,
    /materialized lazily|lazy.*read-time|lazily.*on read/i,
    "docs/03-ROADMAP.md must reference lazy read-time materialization for schema default behavior",
  );
});
