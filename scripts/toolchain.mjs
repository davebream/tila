import { execFileSync } from "node:child_process";

export function toolchain() {
  const version = (command) =>
    execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
  return JSON.stringify({
    os: process.platform,
    arch: process.arch,
    node: process.version,
    bun: version("bun"),
    pnpm: version("pnpm"),
  });
}
