#!/usr/bin/env node
import {
  mcpServerJsonPath,
  parseRoot,
  platformPackages,
  readJson,
} from "./version-policy-lib.mjs";

async function main() {
  const root = parseRoot(process.argv.slice(2));
  const rootPackage = await readJson(root, "package.json");
  const productVersion = rootPackage.version;
  const mismatches = [];

  if (!productVersion) {
    mismatches.push("package.json version is missing");
  }

  async function checkVersion(relativePath) {
    const json = await readJson(root, relativePath);
    if (json.version !== productVersion) {
      mismatches.push(
        `${relativePath} version ${json.version ?? "missing"} != product version ${productVersion}`,
      );
    }
  }

  await checkVersion("packages/cli/package.json");
  for (const name of platformPackages) {
    await checkVersion(`packages/${name.replace("tila-", "")}/package.json`);
  }
  await checkVersion("packages/sdk/package.json");
  await checkVersion("packages/mcp-server/package.json");
  await checkVersion(mcpServerJsonPath);

  const cliPackage = await readJson(root, "packages/cli/package.json");
  for (const name of platformPackages) {
    const pinnedVersion = cliPackage.optionalDependencies?.[name];
    if (pinnedVersion !== productVersion) {
      mismatches.push(
        `packages/cli/package.json optionalDependencies.${name} ${pinnedVersion ?? "missing"} != product version ${productVersion}`,
      );
    }
  }

  if (mismatches.length > 0) {
    console.error("Public release version mismatch:");
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    process.exit(1);
  }

  console.log(`Public release versions aligned at ${productVersion}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
