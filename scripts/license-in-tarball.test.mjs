/**
 * license-in-tarball.test.mjs
 *
 * Assert that every publishable package's npm tarball includes a LICENSE file.
 *
 * Publishable = package.json has publishConfig.access === "public" OR
 *               no "private": true field.
 *
 * npm force-includes a top-level LICENSE from the package directory regardless
 * of the "files" allowlist, so adding a committed LICENSE file is sufficient.
 *
 * Guard: npm pack exits 0 even when bin/ is empty (CI-injected binaries are
 * gitignored). LICENSE assertion is independent of bin/ content.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

/** Enumerate publishable packages (those that will be published to npm). */
async function getPublishablePackages() {
  const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(packagesDir, d.name));

  const publishable = [];
  for (const pkgDir of packageDirs) {
    let pkgJson;
    try {
      pkgJson = JSON.parse(
        await readFile(join(pkgDir, "package.json"), "utf8"),
      );
    } catch {
      continue; // no package.json
    }

    const isPublishable =
      pkgJson.publishConfig?.access === "public" || !pkgJson.private;

    if (isPublishable && pkgJson.name) {
      publishable.push({ dir: pkgDir, name: pkgJson.name });
    }
  }
  return publishable;
}

/** Run npm pack --dry-run --json in pkgDir and return the file list. */
function npmPackDryRun(pkgDir) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  // npm may emit warnings to stderr; only fail if stdout isn't parseable JSON
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `npm pack --dry-run --json failed to produce parseable JSON in ${pkgDir}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return parsed[0]?.files ?? [];
}

test("every publishable package tarball includes LICENSE", async () => {
  const packages = await getPublishablePackages();

  assert.ok(
    packages.length >= 11,
    `Expected at least 11 publishable packages, found ${packages.length}: ${packages.map((p) => p.name).join(", ")}`,
  );

  const missing = [];
  for (const pkg of packages) {
    const files = npmPackDryRun(pkg.dir);
    const hasLicense = files.some(
      (f) => f.path === "LICENSE" || f.path === "LICENCE",
    );
    if (!hasLicense) {
      missing.push(pkg.name);
    }
  }

  assert.equal(
    missing.length,
    0,
    `The following publishable packages are missing a LICENSE file in their tarball:\n${missing.map((n) => `  ${n}`).join("\n")}\n\nFix: add a committed LICENSE file to each package directory.`,
  );
});
