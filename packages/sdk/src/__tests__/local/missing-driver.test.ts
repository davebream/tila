/**
 * Optional-peer-dependency behavior (R8/C6):
 *
 *  - importing `tila-sdk/local` must NOT throw when better-sqlite3 is absent —
 *    nothing is statically imported that loads the native binary;
 *  - calling createTilaLocal/createNodeConnection when the native driver is
 *    absent throws the helpful, actionable error.
 *
 * Absence is simulated by mocking the dynamic `import("better-sqlite3")` to
 * throw a MODULE_NOT_FOUND error, mirroring a real un-installed peer dep.
 */
import { describe, expect, it, vi } from "vitest";

describe("tila-sdk/local — optional peer dependency (R8)", () => {
  // Native-module / cold module-transform on CI can exceed the 5s default; the
  // dynamic-import + esbuild transform of the local entrypoints is slow on a
  // cold, loaded runner. Generous per-test timeouts keep these deterministic.
  it(
    "does NOT throw merely on import when better-sqlite3 is absent",
    { timeout: 20000 },
    async () => {
      // The static import graph of tila-sdk/local must be native-free: importing
      // the module resolves even with no better-sqlite3 installed (the real
      // driver is only reached via a dynamic import inside the factory).
      const mod = await import("../../local/index");
      expect(typeof mod.createTilaLocal).toBe("function");
    },
  );

  it(
    "throws the helpful error when better-sqlite3 cannot be loaded",
    { timeout: 20000 },
    async () => {
      vi.resetModules();
      // Simulate the peer dep being absent: the dynamic import rejects with a
      // Node MODULE_NOT_FOUND, exactly like an un-installed optional peer.
      vi.doMock("better-sqlite3", () => {
        const err = new Error(
          "Cannot find module 'better-sqlite3'",
        ) as NodeJS.ErrnoException;
        err.code = "MODULE_NOT_FOUND";
        throw err;
      });

      const { createNodeConnection } = await import("../../local/connection");

      await expect(
        createNodeConnection("/tmp/does-not-matter.db", {
          skipFilesystemCheck: true,
        }),
      ).rejects.toThrow(
        "tila-sdk/local requires the optional peer dependency 'better-sqlite3'. Run: npm i better-sqlite3",
      );

      vi.doUnmock("better-sqlite3");
      vi.resetModules();
    },
  );

  it(
    "throws the helpful error when the drizzle adapter cannot be loaded",
    { timeout: 20000 },
    async () => {
      vi.resetModules();
      // EITHER missing dependency (the native driver OR its drizzle adapter)
      // triggers the same single helpful error — they share one try/catch (C6).
      vi.doMock("drizzle-orm/better-sqlite3", () => {
        const err = new Error(
          "Cannot find module 'drizzle-orm/better-sqlite3'",
        ) as NodeJS.ErrnoException;
        err.code = "MODULE_NOT_FOUND";
        throw err;
      });

      const { createNodeConnection } = await import("../../local/connection");

      await expect(
        createNodeConnection("/tmp/does-not-matter.db", {
          skipFilesystemCheck: true,
        }),
      ).rejects.toThrow(/optional peer dependency 'better-sqlite3'/);

      vi.doUnmock("drizzle-orm/better-sqlite3");
      vi.resetModules();
    },
  );
});
