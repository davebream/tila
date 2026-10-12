import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeDeployPayload } from "../../lib/deploy";

let temp: string;

function layout({ ui = true, migrations = 2 } = {}) {
  const worker = join(temp, "worker", "index.js");
  mkdirSync(join(temp, "worker"), { recursive: true });
  writeFileSync(worker, "export default {};\n");
  const uiDir = join(temp, "ui", "dist");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "assets", "app.js"), "1");
  if (ui) writeFileSync(join(uiDir, "index.html"), "<html>");
  const migrationsDir = join(temp, "migrations", "global");
  mkdirSync(migrationsDir, { recursive: true });
  for (let i = 1; i <= migrations; i++)
    writeFileSync(join(migrationsDir, `000${i}_m.sql`), "SELECT 1;");
  writeFileSync(join(migrationsDir, "README.md"), "ignored");
  vi.stubEnv("TILA_WORKER_DIST", worker);
  vi.stubEnv("TILA_UI_DIST", uiDir);
  vi.stubEnv("TILA_MIGRATIONS_DIR", migrationsDir);
  return { worker, uiDir, migrationsDir };
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "tila-payload-summary-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});

describe("describeDeployPayload()", () => {
  it("summarizes the Worker, UI files and D1 migrations", () => {
    const { worker, uiDir, migrationsDir } = layout();

    expect(describeDeployPayload()).toEqual({
      version: expect.any(String),
      source: "source",
      overrides: ["TILA_WORKER_DIST", "TILA_UI_DIST", "TILA_MIGRATIONS_DIR"],
      worker,
      ui: { dir: uiDir, files: 2, indexHtml: true },
      migrations: {
        dir: migrationsDir,
        count: 2,
        latest: "0002_m.sql",
      },
    });
  });

  it("requires a built UI outside a source checkout", () => {
    layout({ ui: false });
    expect(() => describeDeployPayload()).toThrow(/UI build not found/);
  });

  it("requires at least one D1 migration", () => {
    layout({ migrations: 0 });
    expect(() => describeDeployPayload()).toThrow(/No D1 migrations found/);
  });

  it("requires the Worker entry point", () => {
    layout();
    vi.stubEnv("TILA_WORKER_DIST", join(temp, "missing.js"));
    expect(() => describeDeployPayload()).toThrow(
      /Worker entry point not found/,
    );
  });
});
