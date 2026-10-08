import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const targets = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-arm64",
  "darwin-x64",
  "windows-x64",
  "windows-arm64",
];
export const binaryName = (target) =>
  `tila-${target}${target.startsWith("windows") ? ".exe" : ""}`;
export const packageDirectories = [
  "sdk",
  ...targets.map((target) => `cli-${target}`),
  "mcp-server",
  "cli",
];
export const digest = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
export const integrity = (bytes) =>
  `sha512-${digest(bytes, "sha512", "base64")}`;
export function run(command, args, options = {}) {
  let executable = command;
  let arguments_ = args;
  // Windows npm/pnpm entry points are command scripts. Use their JS entry point
  // through Node so paths/arguments never pass through a shell.
  if (process.platform === "win32" && command === "npm") {
    arguments_ = [
      resolve(process.execPath, "..", "node_modules/npm/bin/npm-cli.js"),
      ...args,
    ];
    executable = process.execPath;
  }
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  return result.stdout?.trim();
}
export function readManifest(directory) {
  return JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
}

export function validatePackage(manifest, version) {
  assert.equal(manifest.version, version, `${manifest.name}: version mismatch`);
  assert.ok(!manifest.private, `${manifest.name}: private package`);
  assert.ok(
    !JSON.stringify(manifest).includes("workspace:"),
    `${manifest.name}: unresolved workspace reference`,
  );
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ])
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      assert.ok(
        !name.startsWith("@tila/"),
        `${manifest.name}: unpublished runtime dependency ${name}`,
      );
      assert.ok(
        !/^(?:file|link):/.test(specifier),
        `${manifest.name}: local runtime dependency ${name}`,
      );
    }
}
