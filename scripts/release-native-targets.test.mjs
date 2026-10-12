import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { targets } from "./release-common.mjs";

const root = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

// All release binaries are cross-compiled on one host, so pnpm must install
// the optional native addons (e.g. @napi-rs/keyring-*) for every target,
// not just the build host's platform.
test("pnpm installs native addons for every release target", () => {
  const arch = root.pnpm?.supportedArchitectures;
  assert.ok(arch, "package.json pnpm.supportedArchitectures is required");
  const need = {
    os: new Set(
      targets.map((t) => t.split("-")[0].replace("windows", "win32")),
    ),
    cpu: new Set(targets.map((t) => t.split("-")[1])),
    libc: new Set(targets.map((t) => (t.endsWith("musl") ? "musl" : "glibc"))),
  };
  for (const [key, values] of Object.entries(need))
    for (const value of values)
      assert.ok(arch[key]?.includes(value), `${key} must include ${value}`);
});
