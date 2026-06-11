import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

export async function readJson(root, relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
}

export async function writeJson(root, relativePath, value) {
  await writeFile(
    resolve(root, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
