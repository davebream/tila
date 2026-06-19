import type { CommandDef, SubCommandsDef } from "citty";
import { TilaApiError } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPost = vi.fn();

// Mutable config so individual tests can override backend / github.
let mockConfig: Record<string, unknown> = {};

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn(() => ({
    client: { post: mockPost, get: vi.fn(), delete: vi.fn() },
    config: mockConfig,
  })),
}));

const loadCommand = async () => {
  const mod = await import("../../commands/repos");
  return mod.default;
};

function getSubCommand(cmd: CommandDef, name: string): CommandDef {
  const subs = cmd.subCommands;
  if (!subs || typeof subs === "function" || subs instanceof Promise)
    throw new Error("no subCommands");
  const sub = (subs as SubCommandsDef)[name];
  if (!sub || typeof sub === "function" || sub instanceof Promise)
    throw new Error(`no ${name}`);
  return sub;
}

async function runCmd(
  cmd: CommandDef,
  args: Record<string, unknown>,
): Promise<void> {
  if (!cmd.run) throw new Error("no run");
  type RunFn = (ctx: {
    rawArgs: string[];
    args: Record<string, unknown> & { _: string[] };
    cmd: CommandDef;
  }) => Promise<void>;
  await (cmd.run as unknown as RunFn)({
    rawArgs: [],
    args: { ...args, _: [] },
    cmd,
  });
}

function joinCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy.mock.calls as unknown[][]).map((c) => String(c[0])).join("\n");
}

const REGISTERED_RESPONSE = {
  ok: true as const,
  github_repo_id: 12345,
  full_name: "acme/widgets",
  registered_at: 1700000000,
};

function cloudflareConfig() {
  return {
    project_id: "proj-test",
    backend: "cloudflare",
    github: { owner: "acme", repo: "widgets", host: "github.com" },
  };
}

describe("tila repos register", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Throw on exit so control flow stops like the real process.exit would,
    // and so tests can assert the exit code.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mockPost.mockReset();
    mockConfig = cloudflareConfig();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("registers the config-derived repo and prints success (text)", async () => {
    mockPost.mockResolvedValue(REGISTERED_RESPONSE);
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await runCmd(register, {});

    expect(mockPost).toHaveBeenCalledWith(
      "/api/repos",
      { owner: "acme", repo: "widgets", github_host: "github.com" },
      expect.objectContaining({ validate: true }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
    const text = joinCalls(logSpy);
    expect(text).toContain("acme/widgets registered");
    expect(text.toLowerCase()).toContain("safe");
  });

  it("emits a defined --json success envelope", async () => {
    mockPost.mockResolvedValue(REGISTERED_RESPONSE);
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await runCmd(register, { json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out).toEqual({
      ok: true,
      owner: "acme",
      repo: "widgets",
      github_repo_id: 12345,
      full_name: "acme/widgets",
      registered_at: 1700000000,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("lets --owner/--repo flags override config", async () => {
    mockPost.mockResolvedValue(REGISTERED_RESPONSE);
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await runCmd(register, {
      owner: "other",
      repo: "thing",
      host: "ghe.local",
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/api/repos",
      { owner: "other", repo: "thing", github_host: "ghe.local" },
      expect.objectContaining({ validate: true }),
    );
  });

  it("treats an already-registered (201 ok) response as success, exit 0", async () => {
    // The store no-ops on the unique-index conflict; the endpoint still returns
    // 201 { ok: true }, indistinguishable from a fresh register.
    mockPost.mockResolvedValue(REGISTERED_RESPONSE);
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await runCmd(register, {});

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("guards local backend with REMOTE_ONLY, exit 1, no POST", async () => {
    mockConfig = { project_id: "proj-test", backend: "local" };
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await expect(runCmd(register, {})).rejects.toThrow("process.exit(1)");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("errors NO_REPO when owner/repo unresolved, exit 1, no POST", async () => {
    mockConfig = { project_id: "proj-test", backend: "cloudflare" };
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await expect(runCmd(register, {})).rejects.toThrow("process.exit(1)");
    expect(mockPost).not.toHaveBeenCalled();
    const text = joinCalls(errSpy);
    expect(text).toContain("No repo configured");
  });

  it("distinguishes token-authz-denied 403 (full-scope token message)", async () => {
    mockPost.mockRejectedValue(
      new TilaApiError(
        403,
        "UNKNOWN",
        "Repo management requires full scope",
        false,
      ),
    );
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await expect(runCmd(register, {})).rejects.toThrow("process.exit(1)");
    const text = joinCalls(errSpy);
    expect(text).toContain("full-scope token");
    expect(text).not.toContain("cannot access");
    // No token-shaped data leaks into the error output.
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("tila_");
  });

  it("distinguishes repo-access-denied 403 (GitHub-access message, not token-scope)", async () => {
    mockPost.mockRejectedValue(
      new TilaApiError(
        403,
        "UNKNOWN",
        "Access denied to GitHub repo acme/widgets",
        false,
      ),
    );
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await expect(runCmd(register, {})).rejects.toThrow("process.exit(1)");
    const text = joinCalls(errSpy);
    expect(text).toContain("cannot access acme/widgets");
    // Must NOT misdirect to a token-scope fix.
    expect(text).not.toContain("full-scope token");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("tila_");
  });

  it("handles repo-not-found 404 with the not-found message", async () => {
    mockPost.mockRejectedValue(
      new TilaApiError(
        404,
        "UNKNOWN",
        "GitHub repo acme/widgets not found",
        false,
      ),
    );
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await expect(runCmd(register, {})).rejects.toThrow("process.exit(1)");
    const text = joinCalls(errSpy);
    expect(text).toContain("acme/widgets not found");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("tila_");
  });

  it("surfaces a transient/retryable (502/504) error as safe to re-run, exit 1", async () => {
    mockPost.mockRejectedValue(
      new TilaApiError(504, "UNKNOWN", "GitHub API request timed out", true),
    );
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await expect(runCmd(register, {})).rejects.toThrow("process.exit(1)");
    const text = joinCalls(errSpy);
    expect(text).toContain("transient");
    expect(text).toContain("safe to re-run");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("tila_");
  });

  it("surfaces an actionable message when the Worker is unreachable, exit 1", async () => {
    mockPost.mockRejectedValue(
      new Error(
        "Network error connecting to https://example.workers.dev: fetch failed",
      ),
    );
    const cmd = await loadCommand();
    const register = getSubCommand(cmd, "register");

    await expect(runCmd(register, {})).rejects.toThrow("process.exit(1)");
    const text = joinCalls(errSpy);
    expect(text).toContain("Worker not reachable");
    // No success output on the recovery path.
    expect(logSpy).not.toHaveBeenCalled();
  });
});
