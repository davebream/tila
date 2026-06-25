import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PerSlugInfraMeta } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryParseError } from "./errors.js";
import { readInfraMeta, writeInfraMeta } from "./infra-file.js";
import { TilaPaths } from "./paths.js";

describe("infra-file", () => {
  let tmpDir: string;
  let paths: TilaPaths;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-infra-test-"));
    process.env.TILA_HOME = tmpDir;
    paths = new TilaPaths();
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "TILA_HOME");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when infra file does not exist", async () => {
    const result = await readInfraMeta(paths, "my-slug");
    expect(result).toBeNull();
  });

  it("round-trips a valid PerSlugInfraMeta", async () => {
    const meta: PerSlugInfraMeta = {
      account_id: "acc-123",
      account_name: "My Account",
      d1_database_id: "db-456",
      worker_url: "https://example.workers.dev",
    };

    await writeInfraMeta(paths, "my-slug", meta);
    const result = await readInfraMeta(paths, "my-slug");
    expect(result).toEqual(meta);
  });

  it("round-trips a PerSlugInfraMeta with optional fields", async () => {
    const meta: PerSlugInfraMeta = {
      account_id: "acc-789",
      account_name: "Full Account",
      d1_database_id: "db-012",
      worker_url: "https://full.workers.dev",
      pages_project_name: "my-pages-project",
      github_app: {
        app_id: 12345,
        installation_id: 67890,
      },
      infra_slug: "my-slug",
    };

    await writeInfraMeta(paths, "my-slug", meta);
    const result = await readInfraMeta(paths, "my-slug");
    expect(result).toEqual(meta);
  });

  it("creates the infra dir with mode 0o700", async () => {
    const meta: PerSlugInfraMeta = {
      account_id: "acc-123",
      account_name: "My Account",
      d1_database_id: "db-456",
    };

    await writeInfraMeta(paths, "my-slug", meta);
    const dirStat = statSync(paths.infraDir());
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("creates the infra file with mode 0o600", async () => {
    const meta: PerSlugInfraMeta = {
      account_id: "acc-123",
      account_name: "My Account",
      d1_database_id: "db-456",
    };

    await writeInfraMeta(paths, "my-slug", meta);
    const fileStat = statSync(paths.infraFile("my-slug"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("throws RegistryParseError on corrupt TOML", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const infraDir = paths.infraDir();
    mkdirSync(infraDir, { recursive: true });
    writeFileSync(paths.infraFile("my-slug"), "this is not valid toml ][[[", {
      mode: 0o600,
    });

    await expect(readInfraMeta(paths, "my-slug")).rejects.toBeInstanceOf(
      RegistryParseError,
    );
  });

  it("throws RegistryParseError on invalid schema", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const infraDir = paths.infraDir();
    mkdirSync(infraDir, { recursive: true });
    writeFileSync(
      paths.infraFile("my-slug"),
      // Missing required fields (account_id, account_name, d1_database_id)
      `worker_url = "https://example.workers.dev"\n`,
      { mode: 0o600 },
    );

    await expect(readInfraMeta(paths, "my-slug")).rejects.toBeInstanceOf(
      RegistryParseError,
    );
  });
});
