import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const homebrewFormulaPath = "homebrew/Formula/tila.rb";

export const platformPackages = [
  "tila-cli-darwin-arm64",
  "tila-cli-darwin-x64",
  "tila-cli-linux-arm64",
  "tila-cli-linux-arm64-musl",
  "tila-cli-linux-x64",
  "tila-cli-linux-x64-musl",
  "tila-cli-windows-arm64",
  "tila-cli-windows-x64",
];

export const publicPackageJsonPaths = [
  "package.json",
  "packages/cli/package.json",
  ...platformPackages.map(
    (name) => `packages/${name.replace("tila-", "")}/package.json`,
  ),
  "packages/sdk/package.json",
  "packages/mcp-server/package.json",
];

export const mcpServerJsonPath = "packages/mcp-server/server.json";

export const semverPattern =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseRoot(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return process.cwd();
  const root = argv[rootIndex + 1];
  if (!root) {
    throw new Error("--root requires a path");
  }
  return resolve(root);
}

export function parseVersionAndRoot(argv) {
  const root = parseRoot(argv);
  const version = argv.find((arg, index) => {
    if (arg === "--root") return false;
    if (argv[index - 1] === "--root") return false;
    return !arg.startsWith("--");
  });

  if (!version) {
    throw new Error("Usage: bump-version <version> [--root <path>]");
  }

  if (!semverPattern.test(version)) {
    throw new Error("version must match semver, for example 0.2.0");
  }

  return { root, version };
}

/**
 * Rewrite the Homebrew formula's `version` line and URL download tags to
 * the given version. SHA256 values are left unchanged (they are release-derived
 * and authoritatively refreshed by publish-tap.yml on each release).
 *
 * Patterns are compatible with publish-tap.yml:50-63 sed replacements so that
 * running this lockstep automation followed by the tap workflow is idempotent.
 */
export async function bumpHomebrewFormula(root, version) {
  const path = resolve(root, homebrewFormulaPath);
  let content = await readFile(path, "utf8");

  // Rewrite: version "..." → version "<version>"
  content = content.replace(/^(\s*version\s+)"[^"]*"/m, `$1"${version}"`);

  // Rewrite: releases/download/v<old>/tila- → releases/download/v<version>/tila-
  // Only rewrites the tag segment, never the filename — safe against sha256 lines.
  content = content.replace(
    /releases\/download\/v[^/]*\/tila-/g,
    `releases/download/v${version}/tila-`,
  );

  await writeFile(path, content, "utf8");
}

export async function readJson(root, relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
}

export async function writeJson(root, relativePath, value) {
  await writeFile(
    resolve(root, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

/**
 * Implementation/workspace packages that must be marked `private: true`
 * to prevent accidental publishing to npm.
 *
 * These are identified by their `@tila/*` scope or well-known package names
 * that are internal workspace packages.
 */
export const implementationPackagePaths = [
  "packages/backend-d1/package.json",
  "packages/backend-do/package.json",
  "packages/backend-embedded/package.json",
  "packages/backend-local/package.json",
  "packages/backend-r2/package.json",
  "packages/core/package.json",
  "packages/integration-tests/package.json",
  "packages/ops-sqlite/package.json",
  "packages/schemas/package.json",
  "packages/worker/package.json",
  "packages/ui/package.json",
];

/**
 * Check that all implementation packages set `private: true`.
 * Returns an array of paths that are missing the flag.
 */
export async function findNonPrivateImplementationPackages(root) {
  const missing = [];
  for (const relPath of implementationPackagePaths) {
    let pkg;
    try {
      pkg = await readJson(root, relPath);
    } catch {
      // Package doesn't exist in the fixture — skip (fixture tests use subsets)
      continue;
    }
    if (pkg.private !== true) {
      missing.push(relPath);
    }
  }
  return missing;
}
