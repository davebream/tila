import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C8 — SDK /local runtime dependency classification.
 *
 * `@tila/backend-embedded`, `@tila/core`, and `@tila/ops-sqlite` are runtime
 * imports of `tila-sdk/local` (not just dev-time types). They must live in
 * `dependencies`, not `devDependencies`, so that consumers installing
 * `tila-sdk` from npm get these packages transitively.
 */
describe("SDK /local runtime dependency classification", () => {
  const pkgJson = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../package.json"),
      "utf-8",
    ),
  ) as Record<string, Record<string, string>>;

  const deps = pkgJson.dependencies ?? {};
  const devDeps = pkgJson.devDependencies ?? {};

  const RUNTIME_DEPS = [
    "@tila/backend-embedded",
    "@tila/core",
    "@tila/ops-sqlite",
  ];

  for (const pkg of RUNTIME_DEPS) {
    it(`${pkg} is in dependencies (not devDependencies)`, () => {
      expect(
        deps[pkg],
        `${pkg} must be in dependencies — it is a runtime import of tila-sdk/local`,
      ).toBeDefined();
      expect(
        devDeps[pkg],
        `${pkg} must NOT be in devDependencies`,
      ).toBeUndefined();
    });
  }
});
