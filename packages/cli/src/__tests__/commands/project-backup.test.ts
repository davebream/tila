import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExport = vi.fn();
const mockImport = vi.fn();
const mockInspect = vi.fn();
vi.mock("tila-sdk/backup", () => ({
  exportProjectBackup: (...args: unknown[]) => mockExport(...args),
  importProjectBackup: (...args: unknown[]) => mockImport(...args),
  inspectProjectBackup: (...args: unknown[]) => mockInspect(...args),
}));

const mockRequireToken = vi.fn();
vi.mock("../../auth", () => ({
  requireTokenAsync: (...args: unknown[]) => mockRequireToken(...args),
}));

const mockFindConfig = vi.fn();
vi.mock("../../config", () => ({
  findConfig: (...args: unknown[]) => mockFindConfig(...args),
}));

vi.mock("../../lib/output", () => ({ printJson: vi.fn() }));
vi.mock("../../lib/prompts", () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  note: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn().mockResolvedValue(true),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import exportCmd from "../../commands/project/export";
import importCmd from "../../commands/project/import";

const cloudConfig = {
  backend: "cloudflare",
  project_id: "demo",
  worker_url: "https://tila.example",
  tila_version: "0.10.0",
  schema_version: 1,
  cloudflare: { account_id: "acct" },
};

const manifest = {
  project_id: "demo",
  stats: { rows: 1, objects: 0, archive_bytes: 10, elapsed_ms: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindConfig.mockReturnValue(cloudConfig);
  mockRequireToken.mockResolvedValue("project-token");
  mockExport.mockResolvedValue(manifest);
  mockImport.mockResolvedValue({ manifest });
  mockInspect.mockResolvedValue({ manifest });
});
afterEach(() => vi.unstubAllEnvs());

type Runnable = {
  run?: (context: { args: Record<string, unknown> }) => unknown;
};

describe("tila project export (cloud)", () => {
  it("identifies the configured participant to the backup client", async () => {
    vi.stubEnv("TILA_PARTICIPANT_ID", "operator-laptop");
    await (exportCmd as Runnable).run?.({
      args: { output: "/tmp/demo.tila-backup", json: true },
    });

    expect(mockExport).toHaveBeenCalledTimes(1);
    expect(mockExport.mock.calls[0]?.[0]).toMatchObject({
      output: "/tmp/demo.tila-backup",
      source: {
        backend: "cloud",
        projectId: "demo",
        baseUrl: "https://tila.example",
        token: "project-token",
        participantId: "operator-laptop",
      },
    });
  });

  it("falls back to the process participant when none is configured", async () => {
    vi.stubEnv("TILA_PARTICIPANT_ID", "");
    await (exportCmd as Runnable).run?.({
      args: { output: "/tmp/one.tila-backup", json: true },
    });
    await (exportCmd as Runnable).run?.({
      args: { output: "/tmp/two.tila-backup", json: true },
    });

    const first = mockExport.mock.calls[0]?.[0].source.participantId;
    const second = mockExport.mock.calls[1]?.[0].source.participantId;
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it("still requires an absolute output path", async () => {
    await expect(
      (exportCmd as Runnable).run?.({
        args: { output: "relative.tila-backup", json: true },
      }),
    ).rejects.toThrow("--output must be an absolute path");
    expect(mockExport).not.toHaveBeenCalled();
  });
});

describe("tila project import (cloud)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tila-cli-backup-test-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("identifies the configured participant to the restore client", async () => {
    vi.stubEnv("TILA_PARTICIPANT_ID", "operator-laptop");
    const archive = join(root, "demo.tila-backup");
    writeFileSync(archive, "archive");
    await (importCmd as Runnable).run?.({
      args: {
        archive,
        replace: true,
        force: true,
        resume: false,
        rollback: false,
        local: false,
        json: true,
      },
    });

    expect(mockImport).toHaveBeenCalledTimes(1);
    expect(mockImport.mock.calls[0]?.[0].destination).toMatchObject({
      backend: "cloud",
      projectId: "demo",
      token: "project-token",
      participantId: "operator-laptop",
    });
  });
});
