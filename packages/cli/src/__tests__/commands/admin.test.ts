import type { CommandDef, SubCommandsDef } from "citty";
import { TilaApiError } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();

// Mutable config so individual tests can override backend.
let mockConfig: Record<string, unknown> = {};

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn(() => ({
    client: { get: mockGet, post: mockPost, delete: mockDelete },
    config: mockConfig,
  })),
}));

// Mocks for the --token / TILA_TOKEN bypass path (C5).
// findConfig returns the config directly; createCliClient returns a mock client.
vi.mock("../../config", () => ({
  findConfig: vi.fn(() => ({
    project_id: "proj-test",
    worker_url: "https://worker.example.com",
    backend: "cloudflare",
  })),
}));

vi.mock("../../lib/client-factory", () => ({
  createCliClient: vi.fn(() => ({
    get: mockGet,
    post: mockPost,
    delete: mockDelete,
  })),
}));

const loadCommand = async () => {
  const mod = await import("../../commands/admin");
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

function cloudflareConfig() {
  return {
    project_id: "proj-test",
    backend: "cloudflare",
  };
}

const GRANT_RESPONSE = {
  ok: true as const,
  github_user_id: 5555,
  granted: true,
};

const LIST_RESPONSE = {
  ok: true as const,
  admins: [
    {
      github_user_id: 5555,
      login: "alice",
      granted_by: null,
      granted_at: 1700000000,
    },
    {
      github_user_id: 6666,
      login: null,
      granted_by: 5555,
      granted_at: 1700000001,
    },
  ],
};

const REVOKE_RESPONSE = {
  ok: true as const,
  github_user_id: 5555,
  revoked: true,
};

describe("tila admin — REMOTE_ONLY guard", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mockConfig = { project_id: "proj-test", backend: "local" };
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("list rejects local backend", async () => {
    const cmd = await loadCommand();
    const list = getSubCommand(cmd, "list");
    await expect(runCmd(list, {})).rejects.toThrow("process.exit(1)");
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("grant rejects local backend", async () => {
    const cmd = await loadCommand();
    const grant = getSubCommand(cmd, "grant");
    await expect(runCmd(grant, { user: "alice" })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("revoke rejects local backend", async () => {
    const cmd = await loadCommand();
    const revoke = getSubCommand(cmd, "revoke");
    await expect(runCmd(revoke, { user: "5555" })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("tila admin list", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mockConfig = cloudflareConfig();
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("calls GET /projects/:id/admins and prints admins (text)", async () => {
    mockGet.mockResolvedValue(LIST_RESPONSE);
    const cmd = await loadCommand();
    const list = getSubCommand(cmd, "list");

    await runCmd(list, {});

    expect(mockGet).toHaveBeenCalledWith("/projects/proj-test/admins");
    expect(exitSpy).not.toHaveBeenCalled();
    const text = (logSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join("\n");
    expect(text).toContain("5555");
    expect(text).toContain("alice");
  });

  it("--json passthrough: emits result as JSON", async () => {
    mockGet.mockResolvedValue(LIST_RESPONSE);
    const cmd = await loadCommand();
    const list = getSubCommand(cmd, "list");

    await runCmd(list, { json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out).toMatchObject({ ok: true, admins: expect.any(Array) });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("empty roster prints a message", async () => {
    mockGet.mockResolvedValue({ ok: true, admins: [] });
    const cmd = await loadCommand();
    const list = getSubCommand(cmd, "list");

    await runCmd(list, {});

    const text = (logSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join("\n");
    expect(text).toContain("No active admins");
  });
});

describe("tila admin grant", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mockConfig = cloudflareConfig();
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("grant <numeric id> → POST with { github_user_id }", async () => {
    mockPost.mockResolvedValue(GRANT_RESPONSE);
    const cmd = await loadCommand();
    const grant = getSubCommand(cmd, "grant");

    await runCmd(grant, { user: "5555" });

    expect(mockPost).toHaveBeenCalledWith("/projects/proj-test/admins", {
      github_user_id: 5555,
    });
    expect(exitSpy).not.toHaveBeenCalled();
    const text = (logSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join("\n");
    expect(text).toContain("5555");
  });

  it("grant <login> → POST with { login }", async () => {
    const loginResponse = { ok: true, github_user_id: 7777, granted: true };
    mockPost.mockResolvedValue(loginResponse);
    const cmd = await loadCommand();
    const grant = getSubCommand(cmd, "grant");

    await runCmd(grant, { user: "alice" });

    expect(mockPost).toHaveBeenCalledWith("/projects/proj-test/admins", {
      login: "alice",
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("idempotent re-grant (granted:false) prints idempotent message", async () => {
    mockPost.mockResolvedValue({
      ok: true,
      github_user_id: 5555,
      granted: false,
    });
    const cmd = await loadCommand();
    const grant = getSubCommand(cmd, "grant");

    await runCmd(grant, { user: "5555" });

    const text = (logSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join("\n");
    expect(text).toMatch(/already.*admin|idempotent/i);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("--json emits result as JSON", async () => {
    mockPost.mockResolvedValue(GRANT_RESPONSE);
    const cmd = await loadCommand();
    const grant = getSubCommand(cmd, "grant");

    await runCmd(grant, { user: "5555", json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out).toMatchObject({
      ok: true,
      github_user_id: 5555,
      granted: true,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("API error from server → exits non-zero", async () => {
    mockPost.mockRejectedValue(
      new TilaApiError(403, "UNKNOWN", "permission denied", false),
    );
    const cmd = await loadCommand();
    const grant = getSubCommand(cmd, "grant");

    await expect(runCmd(grant, { user: "5555" })).rejects.toThrow(
      "process.exit(1)",
    );
    const errText = (errSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join("\n");
    expect(errText).toContain("403");
  });
});

describe("tila admin revoke", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mockConfig = cloudflareConfig();
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("revoke <numeric id> → DELETE without fetching list", async () => {
    mockDelete.mockResolvedValue(REVOKE_RESPONSE);
    const cmd = await loadCommand();
    const revoke = getSubCommand(cmd, "revoke");

    await runCmd(revoke, { user: "5555" });

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith("/projects/proj-test/admins/5555");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("revoke <login> → fetches list, resolves id, then DELETE", async () => {
    mockGet.mockResolvedValue(LIST_RESPONSE);
    mockDelete.mockResolvedValue({
      ok: true,
      github_user_id: 5555,
      revoked: true,
    });
    const cmd = await loadCommand();
    const revoke = getSubCommand(cmd, "revoke");

    await runCmd(revoke, { user: "alice" });

    expect(mockGet).toHaveBeenCalledWith("/projects/proj-test/admins");
    expect(mockDelete).toHaveBeenCalledWith("/projects/proj-test/admins/5555");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("revoke <login> not in roster → exits non-zero with error", async () => {
    mockGet.mockResolvedValue({ ok: true, admins: [] });
    const cmd = await loadCommand();
    const revoke = getSubCommand(cmd, "revoke");

    await expect(runCmd(revoke, { user: "unknown" })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("--json emits result as JSON", async () => {
    mockDelete.mockResolvedValue(REVOKE_RESPONSE);
    const cmd = await loadCommand();
    const revoke = getSubCommand(cmd, "revoke");

    await runCmd(revoke, { user: "5555", json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out).toMatchObject({
      ok: true,
      github_user_id: 5555,
      revoked: true,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("last-admin 409 → exits non-zero and surfaces the error message", async () => {
    mockDelete.mockRejectedValue(
      new TilaApiError(409, "UNKNOWN", "Cannot revoke the last admin", false),
    );
    const cmd = await loadCommand();
    const revoke = getSubCommand(cmd, "revoke");

    await expect(runCmd(revoke, { user: "5555" })).rejects.toThrow(
      "process.exit(1)",
    );
    const errText = (errSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join("\n");
    // 409 message surfaces verbatim
    expect(errText).toContain("409");
    expect(errText).toContain("last admin");
  });

  it("revoke <login> with null snapshot from list failure → exits non-zero", async () => {
    mockGet.mockRejectedValue(new Error("network failure"));
    const cmd = await loadCommand();
    const revoke = getSubCommand(cmd, "revoke");

    await expect(runCmd(revoke, { user: "alice" })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("tila admin — --token / TILA_TOKEN override (C5 bootstrap)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let isTTYOriginal: boolean | undefined;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    mockConfig = cloudflareConfig();
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    // Ensure no TILA_TOKEN in env by default
    process.env.TILA_TOKEN = undefined;
    // Default: non-TTY (CI mode — no warning expected)
    isTTYOriginal = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
    process.env.TILA_TOKEN = undefined;
    Object.defineProperty(process.stdout, "isTTY", {
      value: isTTYOriginal,
      configurable: true,
    });
  });

  it("--token bypasses resolveContext and calls createCliClient directly", async () => {
    const { createCliClient } = await import("../../lib/client-factory");
    const createCliClientMock = vi.mocked(createCliClient);
    createCliClientMock.mockReturnValue({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    const { resolveContext } = await import("../../context");
    const resolveContextMock = vi.mocked(resolveContext);
    resolveContextMock.mockReset();

    mockGet.mockResolvedValue(LIST_RESPONSE);
    const cmd = await loadCommand();
    const list = getSubCommand(cmd, "list");

    await runCmd(list, { token: "my-d1-token" });

    // createCliClient should be called with the token (not resolveContext)
    expect(createCliClientMock).toHaveBeenCalledWith(
      "https://worker.example.com",
      "my-d1-token",
    );
    // resolveContext should NOT have been called
    expect(resolveContextMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("TILA_TOKEN env var bypasses resolveContext", async () => {
    process.env.TILA_TOKEN = "env-d1-token";

    const { createCliClient } = await import("../../lib/client-factory");
    const createCliClientMock = vi.mocked(createCliClient);
    createCliClientMock.mockReturnValue({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    const { resolveContext } = await import("../../context");
    const resolveContextMock = vi.mocked(resolveContext);
    resolveContextMock.mockReset();

    mockPost.mockResolvedValue(GRANT_RESPONSE);
    const cmd = await loadCommand();
    const grant = getSubCommand(cmd, "grant");

    await runCmd(grant, { user: "5555" });

    expect(createCliClientMock).toHaveBeenCalledWith(
      "https://worker.example.com",
      "env-d1-token",
    );
    expect(resolveContextMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("--token with isTTY=true prints process-table warning", async () => {
    // Simulate interactive TTY
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });

    const { createCliClient } = await import("../../lib/client-factory");
    const createCliClientMock = vi.mocked(createCliClient);
    createCliClientMock.mockReturnValue({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    mockGet.mockResolvedValue(LIST_RESPONSE);
    const cmd = await loadCommand();
    const list = getSubCommand(cmd, "list");

    await runCmd(list, { token: "my-d1-token" });

    // Should warn about process table visibility
    const warnText = (warnSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join("\n");
    expect(warnText).toMatch(/ps aux|process table/i);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("TILA_TOKEN with isTTY=true does NOT print warning (env var is safe)", async () => {
    process.env.TILA_TOKEN = "env-d1-token";
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });

    const { createCliClient } = await import("../../lib/client-factory");
    const createCliClientMock = vi.mocked(createCliClient);
    createCliClientMock.mockReturnValue({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any);

    mockGet.mockResolvedValue(LIST_RESPONSE);
    const cmd = await loadCommand();
    const list = getSubCommand(cmd, "list");

    await runCmd(list, {}); // no --token arg, only env var

    // No process-table warning for env var usage
    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
