import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C8 — SDK /local runtime dependency classification.
 *
 * `@tila/backend-embedded`, `@tila/core`, and `@tila/ops-sqlite` are runtime
 * imports of `tila-sdk/local` (not just dev-time types). They are bundled into the published outputs, so they belong in
 * `devDependencies`. Publishing them as dependencies would ask consumers to
 * install private, unpublished packages. Clean-tarball release smoke tests
 * verify the bundled local backend still works.
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
    it(`${pkg} is bundled instead of required from npm`, () => {
      expect(
        deps[pkg],
        `${pkg} must not be an unpublished runtime dependency`,
      ).toBeUndefined();
      expect(
        devDeps[pkg],
        `${pkg} must be available to the bundler`,
      ).toBeDefined();
    });
  }
});
