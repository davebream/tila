/**
 * CJS → ESM local-entry interop guard.
 *
 * `createTila`'s local branch does `await import("./local/index")`. The main
 * tsup config externalizes + rewrites that to the sibling ESM entry
 * (`./local.js`) so the zod-only main entry NEVER inlines the heavy SQLite
 * stack — for BOTH `dist/index.js` (ESM) and `dist/index.cjs` (CJS). Importing
 * the ESM `local.js` from CJS relies on Node's async ESM interop (`await
 * import()` works from a CJS module).
 *
 * This test proves that mechanism end-to-end: it `require()`s the BUILT
 * `dist/index.cjs` (a real CommonJS load), calls `createTila({backend:"local"})`
 * against a temp dir, and round-trips a task. If the esbuild rewrite regresses
 * — e.g. the plugin stops externalizing `./local/index`, or points at a
 * non-existent path — this require/import chain throws and the test FAILS. It
 * never skips: the build runs on demand in `beforeAll` (mirroring
 * `bundle-hygiene.test.ts`), so the CJS bundle always exists.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// packages/sdk/src/__tests__ -> packages/sdk
const sdkRoot = resolve(here, "..", "..");
const distCjs = resolve(sdkRoot, "dist", "index.cjs");

beforeAll(() => {
  // Build on demand so the CJS bundle (and its sibling local.js) always exist,
  // even under `pnpm test` where turbo does not pre-build tila-sdk's own dist.
  execSync("pnpm --filter tila-sdk build", {
    cwd: resolve(sdkRoot, "..", ".."),
    stdio: "ignore",
  });
}, 120_000);

describe("dist/index.cjs loads the local stack via the ./local.js rewrite", () => {
  it("require()s the CJS bundle and round-trips a local task", async () => {
    // A genuine CommonJS require of the built bundle — this is the path a CJS
    // consumer (`require("tila-sdk")`) takes.
    const require = createRequire(import.meta.url);
    const mod = require(distCjs) as typeof import("../index");
    expect(typeof mod.createTila).toBe("function");

    const dir = mkdtempSync(join(tmpdir(), "tila-cjs-interop-"));
    try {
      // Local branch: triggers `await import("./local.js")` from inside the CJS
      // bundle. If the rewrite broke, this rejects.
      const tila = await mod.createTila({
        project_id: "cjs-proj",
        backend: "local",
        local: {
          db_path: join(dir, "project.db"),
          artifacts_path: join(dir, "artifacts"),
          org: "cjs-org",
        },
        schema_version: 1,
        tila_version: "0.0.0",
        created_at: "2026-01-01T00:00:00Z",
      });
      try {
        const created = await tila.tasks.create("cjs-task", "task", {
          title: "loaded via cjs",
        });
        expect(created.entity.id).toBe("cjs-task");
        const got = await tila.tasks.get("cjs-task");
        expect(got.entity.id).toBe("cjs-task");
      } finally {
        tila.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
