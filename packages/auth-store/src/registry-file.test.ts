import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstanceRegistry } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryParseError } from "./errors.js";
import { TilaPaths } from "./paths.js";
import { readRegistry, writeRegistry } from "./registry-file.js";

describe("registry-file", () => {
  let tmpDir: string;
  let paths: TilaPaths;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-registry-test-"));
    process.env.TILA_HOME = tmpDir;
    paths = new TilaPaths();
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "TILA_HOME");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when registry file does not exist", async () => {
    const result = await readRegistry(paths);
    expect(result).toBeNull();
  });

  it("round-trips a valid registry", async () => {
    const registry: InstanceRegistry = {
      version: 1,
      current_context: null,
      instances: [],
    };

    await writeRegistry(paths, registry);
    const result = await readRegistry(paths);
    expect(result).toEqual(registry);
  });

  it("round-trips a registry with instances", async () => {
    const registry: InstanceRegistry = {
      version: 1,
      current_context: "my-key" as import("@tila/schemas").InstanceKey,
      instances: [
        {
          instance_key: "my-key" as import("@tila/schemas").InstanceKey,
          label: "My Instance",
          worker_url: "https://example.com",
          instance_id_source: "client-uuid",
          trust: { trusted: true, trusted_at: 1700000000000 },
          created_at: 1700000000000,
        },
      ],
    };

    await writeRegistry(paths, registry);
    const result = await readRegistry(paths);
    expect(result).toEqual(registry);
  });

  it("creates the home dir with mode 0o700", async () => {
    const registry: InstanceRegistry = {
      version: 1,
      current_context: null,
      instances: [],
    };

    await writeRegistry(paths, registry);
    const dirStat = statSync(tmpDir);
    // Check that the directory mode includes 0o700 (owner rwx)
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("creates the registry file with mode 0o600", async () => {
    const registry: InstanceRegistry = {
      version: 1,
      current_context: null,
      instances: [],
    };

    await writeRegistry(paths, registry);
    const fileStat = statSync(paths.registryFile());
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("throws RegistryParseError on corrupt TOML", async () => {
    // Write a corrupt TOML file directly
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(paths.registryFile(), "this is not valid toml ][[[", {
      mode: 0o600,
    });

    await expect(readRegistry(paths)).rejects.toBeInstanceOf(
      RegistryParseError,
    );
  });

  it("throws RegistryParseError on invalid schema", async () => {
    // Write valid TOML but with wrong shape
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      paths.registryFile(),
      // Missing required fields
      `version = "not-a-number"\n`,
      { mode: 0o600 },
    );

    await expect(readRegistry(paths)).rejects.toBeInstanceOf(
      RegistryParseError,
    );
  });
});
