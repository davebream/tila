#!/usr/bin/env node
import {
  bumpHomebrewFormula,
  mcpServerJsonPath,
  parseVersionAndRoot,
  platformPackages,
  publicPackageJsonPaths,
  readJson,
  writeJson,
} from "./version-policy-lib.mjs";

async function main() {
  const { root, version } = parseVersionAndRoot(process.argv.slice(2));

  for (const relativePath of publicPackageJsonPaths) {
    const json = await readJson(root, relativePath);
    json.version = version;

    if (relativePath === "packages/cli/package.json") {
      json.optionalDependencies ??= {};
      for (const name of platformPackages) {
        json.optionalDependencies[name] = version;
      }
    }

    await writeJson(root, relativePath, json);
  }

  const serverJson = await readJson(root, mcpServerJsonPath);
  serverJson.version = version;
  await writeJson(root, mcpServerJsonPath, serverJson);

  await bumpHomebrewFormula(root, version);

  console.log(`Bumped public release version to ${version}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
