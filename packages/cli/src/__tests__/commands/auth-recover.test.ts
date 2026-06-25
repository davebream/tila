/**
 * Tests for `tila auth recover`.
 *
 * Verifies:
 *   - recover regenerates the DPoP key (new jkt differs from the old one)
 *   - headless / CI lockout emits an actionable error and exits 1
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// @clack/prompts — silence UI output
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
}));

// Stable fake config / tilaDir helpers
const mockFindConfig = vi.fn();
const mockFindTilaDir = vi.fn();
vi.mock("../../config", () => ({
  findConfig: (...args: unknown[]) => mockFindConfig(...args),
  findTilaDir: (...args: unknown[]) => mockFindTilaDir(...args),
}));

// resolveGithubRepoToken — mock so we don't hit real network
const mockResolveGithubRepoToken = vi.fn();
vi.mock("../../lib/github-exchange", () => ({
  resolveGithubRepoToken: (...args: unknown[]) =>
    mockResolveGithubRepoToken(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let savedCI: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  tempDir = join(
    process.env.TMPDIR ?? "/tmp",
    `tila-test-auth-recover-${Date.now()}`,
  );
  mkdirSync(tempDir, { recursive: true });

  // Default: interactive mode
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  // Save and unset CI so we start each test in interactive mode
  savedCI = process.env.CI;
  process.env.CI = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
  // Restore CI env var to its original value
  if (savedCI !== undefined) {
    process.env.CI = savedCI;
  } else {
    process.env.CI = "";
  }
});

function getSubCommand(cmd: CommandDef, name: string): CommandDef {
  const subs = cmd.subCommands;
  if (!subs || typeof subs === "function" || subs instanceof Promise) {
    throw new Error("no subCommands");
  }
  const sub = (subs as SubCommandsDef)[name];
  if (!sub || typeof sub === "function" || sub instanceof Promise) {
    throw new Error(`no subcommand: ${name}`);
  }
  return sub;
}

async function runSubCommand(
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  const mod = await import("../../commands/auth");
  const cmd = mod.default;
  const sub = getSubCommand(cmd, name);
  if (!sub.run) throw new Error(`subcommand ${name} has no run`);
  type RunFn = (ctx: {
    rawArgs: string[];
    args: Record<string, unknown> & { _: string[] };
    cmd: CommandDef;
  }) => Promise<void>;
  await (sub.run as unknown as RunFn)({
    rawArgs: [],
    args: { ...args, _: [] },
    cmd: sub,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tila auth recover — headless / CI lockout", () => {
  it("exits 1 with actionable error when --headless flag is set", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const p = await import("@clack/prompts");

    await expect(runSubCommand("recover", { headless: true })).rejects.toThrow(
      "process.exit",
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("interactive terminal"),
    );
  });

  it("exits 1 with actionable error when CI env var is set", async () => {
    process.env.CI = "true";
    // Also suppress TTY so the CI check takes effect
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const p = await import("@clack/prompts");

    await expect(runSubCommand("recover")).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("interactive terminal"),
    );
  });

  it("error message includes recovery steps (token and session)", async () => {
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const p = await import("@clack/prompts");

    await expect(
      runSubCommand("recover", { headless: true }),
    ).rejects.toThrow();

    const errorMsg = (p.log.error as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(errorMsg).toMatch(/interactive terminal/i);
    expect(errorMsg).toMatch(/tila auth recover/);
  });
});

describe("tila auth recover — github-repo mode", () => {
  beforeEach(() => {
    mockFindConfig.mockReturnValue({
      project_id: "proj-test",
      worker_url: "https://tila.example.com",
      auth: { mode: "github-repo" },
      github: { host: "github.com", owner: "acme", repo: "app" },
    });
    mockFindTilaDir.mockReturnValue(tempDir);
    mockResolveGithubRepoToken.mockResolvedValue("session_new_token");
  });

  it("calls resolveGithubRepoToken with a non-empty jkt", async () => {
    await runSubCommand("recover");

    expect(mockResolveGithubRepoToken).toHaveBeenCalledOnce();
    const [, , jkt] = mockResolveGithubRepoToken.mock.calls[0] as [
      unknown,
      unknown,
      string,
    ];
    // jkt is a base64url SHA-256 JWK thumbprint — 43 chars, no padding
    expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("drops the stale .session file before re-exchanging", async () => {
    const sessionPath = join(tempDir, ".session");
    writeFileSync(sessionPath, JSON.stringify({ session_token: "old" }));

    const { existsSync } = await import("node:fs");
    expect(existsSync(sessionPath)).toBe(true);

    await runSubCommand("recover");

    // After recover, the stale session was deleted before the exchange;
    // resolveGithubRepoToken mock writes no file, so it stays absent.
    expect(existsSync(sessionPath)).toBe(false);
  });

  it("generates a different jkt each time (keypair is regenerated)", async () => {
    await runSubCommand("recover");
    const jkt1 = (
      mockResolveGithubRepoToken.mock.calls[0] as [unknown, unknown, string]
    )[2];

    mockResolveGithubRepoToken.mockClear();
    vi.resetModules();
    await runSubCommand("recover");
    const jkt2 = (
      mockResolveGithubRepoToken.mock.calls[0] as [unknown, unknown, string]
    )[2];

    // Two consecutive recover runs produce different key thumbprints
    expect(jkt1).not.toBe(jkt2);
  });
});

describe("tila auth recover — missing config", () => {
  it("exits 1 when no config is found", async () => {
    mockFindConfig.mockReturnValue(null);
    mockFindTilaDir.mockReturnValue(null);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runSubCommand("recover")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
