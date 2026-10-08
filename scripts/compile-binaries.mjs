import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryName, run, targets } from "./release-common.mjs";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const selected = process.argv.slice(2);
const compileTargets = selected.length ? selected : targets;
for (const target of compileTargets)
  if (!targets.includes(target))
    throw new Error(`Unknown binary target: ${target}`);
run(process.execPath, ["scripts/generate-version.mjs", "cli"], {
  stdio: "inherit",
});
run(process.execPath, ["scripts/generate-version.mjs", "backend-do"], {
  stdio: "inherit",
});
run("pnpm", ["--filter", "tila-cli", "run", "build:worker-sidecar"], {
  stdio: "inherit",
});
const cwd = resolve("packages/cli");
mkdirSync(resolve(cwd, "dist/binaries"), { recursive: true });
mkdirSync(resolve(cwd, "dist/metadata"), { recursive: true });
for (const target of compileTargets) {
  const name = binaryName(target);
  run(
    "bun",
    [
      "build",
      "--compile",
      "--define",
      `TILA_BUILD_TARGET=${JSON.stringify(target)}`,
      `--metafile=dist/metadata/${name}.json`,
      "--target",
      `bun-${target}`,
      "src/index.ts",
      "--outfile",
      `dist/binaries/${name}`,
    ],
    { cwd, stdio: "inherit" },
  );
}
run("pnpm", ["--filter", "tila-cli", "run", "compile:installers"], {
  stdio: "inherit",
});
