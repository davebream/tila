/**
 * Bundle-hygiene invariant: the tila-sdk MAIN entry (`dist/index.js` /
 * `dist/index.cjs`) must stay ZOD-ONLY. It exposes the HTTP RemoteBackend seam,
 * which needs @tila/core interface TYPES only — never core's heavy runtime
 * (the schema-as-config parser, the grep engine) and never the native SQLite
 * stack. Those belong exclusively in the future `tila-sdk/local` entry (Task 9).
 *
 * This is a genuine CI guard, not a manual grep: if a regression (e.g. adding
 * @tila/core to `noExternal`, or importing a core VALUE into the remote
 * backends) pulls heavy runtime into the main bundle, this test FAILS.
 *
 * Robustness: the SDK is built on demand in `beforeAll` so the bundle always
 * exists when the assertions run. The repo's CI invokes `pnpm test` (turbo
 * `test` dependsOn `^build`, which builds only UPSTREAM deps, not tila-sdk's
 * own dist), so we cannot rely on dist being present — we build it here.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// packages/sdk/src/__tests__ -> packages/sdk
const sdkRoot = resolve(here, "..", "..");
const distDir = resolve(sdkRoot, "dist");

// Identifiers that, if present in the main bundle, prove core's heavy runtime
// or the native SQLite stack leaked into the zod-only entry. These are the REAL
// @tila/core value exports (see packages/core/src/index.ts):
//   - schema-as-config parser:  parseSchemaToml, parseTilaSchemaToml
//   - schema fragment composer: composeSchemaFragments
//   - grep engine:              compileGrepMatcher, matchLine, splitChunkIntoLines
// plus heavy/native module specifiers that must never reach the main entry.
const FORBIDDEN_IDENTIFIERS = [
  // @tila/core schema-as-config parser
  "parseSchemaToml",
  "parseTilaSchemaToml",
  "composeSchemaFragments",
  // @tila/core grep engine
  "compileGrepMatcher",
  "matchLine",
  "splitChunkIntoLines",
  // native / heavy module specifiers
  "better-sqlite3",
  "bun:sqlite",
  "node:fs",
  "@tila/ops-sqlite",
  "@tila/backend-embedded",
];

beforeAll(() => {
  // Build the SDK so the main-entry bundle exists. Self-contained: works under
  // `pnpm test` in CI even though turbo's `test` task does not build tila-sdk's
  // own dist beforehand.
  execSync("pnpm --filter tila-sdk build", {
    cwd: resolve(sdkRoot, "..", ".."),
    stdio: "ignore",
  });
}, 120_000);

describe("main entry bundle stays zod-only", () => {
  // dist/index.js (ESM) is always produced; dist/index.cjs (CJS) is too.
  const candidates = ["index.js", "index.cjs"];

  it("produced the main-entry bundle(s)", () => {
    expect(
      existsSync(resolve(distDir, "index.js")),
      "Expected dist/index.js to exist after building tila-sdk. Run `pnpm --filter tila-sdk build` first.",
    ).toBe(true);
  });

  for (const file of candidates) {
    it(`${file} contains no heavy @tila/core runtime or native stack`, () => {
      const path = resolve(distDir, file);
      if (!existsSync(path)) {
        // index.cjs should exist (format: ["esm","cjs"]); if a future config
        // drops a format, skip only the truly-absent file — never the ESM one,
        // which the assertion above pins as required.
        if (file === "index.cjs") return;
        throw new Error(`Expected bundle ${file} to exist for hygiene check`);
      }
      const source = readFileSync(path, "utf8");
      const leaked = FORBIDDEN_IDENTIFIERS.filter((id) => source.includes(id));
      expect(
        leaked,
        `Main entry bundle ${file} must stay zod-only, but these heavy symbols leaked: ${leaked.join(", ")}. This usually means @tila/core's runtime (schema parser / grep engine) or the native SQLite stack was pulled into the main entry — keep that in the tila-sdk/local entry, and use dts.resolve (types) for @tila/core in the main config, never noExternal.`,
      ).toEqual([]);
    });
  }
});
