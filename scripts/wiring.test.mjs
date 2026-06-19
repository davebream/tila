import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");

test("root package.json has test:scripts script containing node --test", async () => {
  const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));

  assert.ok(
    pkg.scripts?.["test:scripts"],
    'package.json must have a "test:scripts" script',
  );
  assert.match(
    pkg.scripts["test:scripts"],
    /node --test/,
    '"test:scripts" must contain "node --test"',
  );
});

test("root package.json test:scripts glob resolves at least one .test.mjs file", () => {
  const files = readdirSync(scriptDir).filter((f) => f.endsWith(".test.mjs"));
  assert.ok(
    files.length > 0,
    `scripts/ must contain at least one .test.mjs file, found: ${files.length}`,
  );
});

test('root package.json "test" script includes "test:scripts"', async () => {
  const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));

  assert.ok(pkg.scripts?.test, 'package.json must have a "test" script');
  assert.match(
    pkg.scripts.test,
    /test:scripts/,
    '"test" script must include "test:scripts"',
  );
});
