import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindTilaDir = vi.fn();
vi.mock("../../config", () => ({
  findTilaDir: (...args: unknown[]) => mockFindTilaDir(...args),
}));

vi.mock("@clack/prompts", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

let tempDir: string;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  tempDir = join(
    process.env.TMPDIR ?? "/tmp",
    `tila-test-disconnect-${Date.now()}`,
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function runDisconnect() {
  const mod = await import("../../commands/disconnect");
  const cmd = mod.default;
  await (cmd.run as (opts: { args: Record<string, unknown> }) => Promise<void>)(
    { args: {} },
  );
}

describe("tila disconnect", () => {
  it("removes .env, .session, and github-token-cache.json from .tila/", async () => {
    mockFindTilaDir.mockReturnValue(tempDir);

    // Create credential files
    writeFileSync(join(tempDir, ".env"), "TOKEN=secret");
    writeFileSync(join(tempDir, ".session"), "session-data");
    writeFileSync(
      join(tempDir, "github-token-cache.json"),
      '{"token":"gh_xxx"}',
    );
    // Also create config.toml to verify it is preserved
    writeFileSync(join(tempDir, "config.toml"), 'project_id = "test"');

    await runDisconnect();

    expect(existsSync(join(tempDir, ".env"))).toBe(false);
    expect(existsSync(join(tempDir, ".session"))).toBe(false);
    expect(existsSync(join(tempDir, "github-token-cache.json"))).toBe(false);
  });

  it("preserves config.toml", async () => {
    mockFindTilaDir.mockReturnValue(tempDir);

    writeFileSync(join(tempDir, ".env"), "TOKEN=secret");
    writeFileSync(join(tempDir, "config.toml"), 'project_id = "test"');

    await runDisconnect();

    expect(existsSync(join(tempDir, "config.toml"))).toBe(true);
  });

  it("handles case where no credential files exist (already disconnected)", async () => {
    mockFindTilaDir.mockReturnValue(tempDir);
    // No credential files in tempDir — only the directory exists

    const p = await import("@clack/prompts");

    await runDisconnect();

    expect(p.log.info).toHaveBeenCalledWith(
      "No credential files found — already disconnected.",
    );
  });

  it("exits 1 when .tila/ directory does not exist", async () => {
    mockFindTilaDir.mockReturnValue(null);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    const p = await import("@clack/prompts");

    await expect(runDisconnect()).rejects.toThrow("exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(p.log.error).toHaveBeenCalledWith("No .tila/ directory found.");
  });
});
