import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toolchain } from "./toolchain.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const env = {
  ...process.env,
  TILA_BUILD_REVISION: revision,
  TILA_TOOLCHAIN: toolchain(),
};
const result = spawnSync("pnpm", ["exec", "turbo", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
