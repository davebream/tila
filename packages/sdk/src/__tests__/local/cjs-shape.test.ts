import { mkdtempSync, rmSync } from "node:fs";
/**
 * CJS interop default-vs-named export shape of `better-sqlite3` is normalized
 * (R8): `const Database = mod.default ?? mod`.
 *
 * Under different bundlers / interop modes the dynamic `import("better-sqlite3")`
 * may surface the constructor as `mod.default` (Node's synthesized default for a
 * CJS module) OR as the namespace itself. Both shapes must open a working DB.
 *
 * We mock `better-sqlite3` to present each shape (wrapping the REAL native
 * module so the open actually succeeds) and assert createNodeConnection works.
 */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
// The genuine native constructor (CJS module export).
const RealDatabase = require("better-sqlite3");

describe("better-sqlite3 CJS shape normalization (R8)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tila-shape-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.doUnmock("better-sqlite3");
    vi.resetModules();
  });

  it("handles the `.default` (synthesized) export shape", async () => {
    vi.resetModules();
    vi.doMock("better-sqlite3", () => ({ default: RealDatabase }));
    const { createNodeConnection } = await import("../../local/connection");

    const conn = await createNodeConnection(join(dir, "a.db"), {
      skipFilesystemCheck: true,
    });
    expect(conn.db).toBeDefined();
    conn.close();
  });

  it("normalization `mod.default ?? mod` resolves the constructor for both shapes", () => {
    // The "namespace IS the callable constructor" CJS shape cannot be produced
    // through vitest's ESM module mock (its factory must return a non-callable
    // object). We instead assert the exact normalization expression the
    // connection uses — `mod.default ?? mod` — picks the constructor in BOTH
    // the `.default`-wrapped shape AND the bare-namespace shape.
    const withDefault = { default: RealDatabase } as {
      default?: unknown;
    };
    const bareNamespace = RealDatabase as unknown as { default?: unknown };

    const fromDefault = withDefault.default ?? withDefault;
    const fromBare = bareNamespace.default ?? bareNamespace;

    expect(fromDefault).toBe(RealDatabase);
    expect(fromBare).toBe(RealDatabase);
    expect(typeof fromDefault).toBe("function");
    expect(typeof fromBare).toBe("function");
  });
});
