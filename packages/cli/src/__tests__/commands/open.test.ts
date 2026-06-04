import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config", () => ({
  findConfig: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// biome-ignore lint/suspicious/noExplicitAny: citty run function args type bypass
async function runCmd(cmd: any, args: Record<string, unknown>): Promise<void> {
  if (!cmd.run) throw new Error("no run");
  await (cmd.run as (opts: { args: Record<string, unknown> }) => Promise<void>)(
    { args: { ...args, _: [] } },
  );
}

describe("tila open", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(
      (_code: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      },
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("calls execFile with URL when config has worker_url", async () => {
    const { findConfig } = await import("../../config");
    const { execFile } = await import("node:child_process");

    vi.mocked(findConfig).mockReturnValue({
      project_id: "test-proj",
      schema_version: 1,
      tila_version: "0.1.0",
      created_at: "2026-05-21T00:00:00Z",
      backend: "cloudflare",
      worker_url: "https://test.workers.dev",
    });

    // Simulate execFile calling its callback with no error
    vi.mocked(execFile).mockImplementation(
      (_file: string, _args?: unknown, callback?: unknown) => {
        if (typeof callback === "function") {
          callback(null, "", "");
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const mod = await import("../../commands/open");
    await runCmd(mod.default, { print: false });

    expect(execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["https://test.workers.dev"]),
      expect.any(Function),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("prints URL to stdout and does not call execFile when --print flag is set", async () => {
    const { findConfig } = await import("../../config");
    const { execFile } = await import("node:child_process");

    vi.mocked(findConfig).mockReturnValue({
      project_id: "test-proj",
      schema_version: 1,
      tila_version: "0.1.0",
      created_at: "2026-05-21T00:00:00Z",
      backend: "cloudflare",
      worker_url: "https://test.workers.dev",
    });

    const mod = await import("../../commands/open");
    await runCmd(mod.default, { print: true });

    expect(logSpy).toHaveBeenCalledWith("https://test.workers.dev");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("logs error and exits 1 when no config found", async () => {
    const { findConfig } = await import("../../config");

    vi.mocked(findConfig).mockReturnValue(null);

    const mod = await import("../../commands/open");
    await expect(runCmd(mod.default, { print: false })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No tila project found"),
    );
  });

  it("logs error and exits 1 when config has no worker_url", async () => {
    const { findConfig } = await import("../../config");

    vi.mocked(findConfig).mockReturnValue({
      project_id: "test-proj",
      schema_version: 1,
      tila_version: "0.1.0",
      created_at: "2026-05-21T00:00:00Z",
      backend: "cloudflare",
    });

    const mod = await import("../../commands/open");
    await expect(runCmd(mod.default, { print: false })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("worker_url"),
    );
  });

  it("logs local-mode error and exits 1 when backend is local with no worker_url", async () => {
    const { findConfig } = await import("../../config");

    vi.mocked(findConfig).mockReturnValue({
      project_id: "local-proj",
      schema_version: 1,
      tila_version: "0.1.0",
      created_at: "2026-05-21T00:00:00Z",
      backend: "local",
    } as ReturnType<typeof findConfig>);

    const mod = await import("../../commands/open");
    await expect(runCmd(mod.default, { print: false })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("local"));
  });

  it("logs fallback message with URL when execFile fails", async () => {
    const { findConfig } = await import("../../config");
    const { execFile } = await import("node:child_process");

    vi.mocked(findConfig).mockReturnValue({
      project_id: "test-proj",
      schema_version: 1,
      tila_version: "0.1.0",
      created_at: "2026-05-21T00:00:00Z",
      backend: "cloudflare",
      worker_url: "https://test.workers.dev",
    });

    vi.mocked(execFile).mockImplementation(
      (_file: string, _args?: unknown, callback?: unknown) => {
        if (typeof callback === "function") {
          callback(new Error("spawn failed"), "", "");
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const mod = await import("../../commands/open");
    await runCmd(mod.default, { print: false });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://test.workers.dev"),
    );
  });
});
