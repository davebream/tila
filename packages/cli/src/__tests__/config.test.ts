import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TilaProjectConfig } from "@tila/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFile, writeConfigFile } from "../config";

describe("writeConfigFile", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a valid config that can be loaded back", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, ".tila");

    const config: TilaProjectConfig = {
      project_id: "test-abc123",
      worker_url: "https://tila-test-abc123.workers.dev",
      schema_version: 1,
      tila_version: "0.1.0",
      created_at: new Date().toISOString(),
      cloudflare: { account_id: "acc-123" },
      backends: {
        entity: "do-sqlite",
        coordination: "do-sqlite",
        artifact: "r2",
        auth: "d1",
      },
    };

    writeConfigFile(config, tilaDir);

    const loaded = loadConfigFile(join(tilaDir, "config.toml"));
    expect(loaded.project_id).toBe("test-abc123");
    expect(loaded.worker_url).toBe("https://tila-test-abc123.workers.dev");
    expect(loaded.cloudflare?.account_id).toBe("acc-123");
  });

  it("creates the directory if it does not exist", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, "nested", ".tila");

    const config: TilaProjectConfig = {
      project_id: "test-create-dir",
      worker_url: "https://tila-test.workers.dev",
      schema_version: 1,
      tila_version: "0.1.0",
      created_at: new Date().toISOString(),
      cloudflare: { account_id: "acc-456" },
      backends: {
        entity: "do-sqlite",
        coordination: "do-sqlite",
        artifact: "r2",
        auth: "d1",
      },
    };

    // Should not throw even though directory doesn't exist yet
    expect(() => writeConfigFile(config, tilaDir)).not.toThrow();
    const content = readFileSync(join(tilaDir, "config.toml"), "utf-8");
    expect(content).toContain("test-create-dir");
  });

  it("throws on invalid config", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, ".tila");

    expect(() =>
      writeConfigFile({ project_id: "x" } as TilaProjectConfig, tilaDir),
    ).toThrow("Invalid config");
  });
});
