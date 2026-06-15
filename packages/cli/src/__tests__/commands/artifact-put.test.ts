/**
 * artifact put output tests.
 *
 * The README promises that a second identical (content-addressed) put prints
 * "Deduplicated" rather than "Uploaded". The backend now reports a
 * `deduplicated` flag on the put result; these tests pin the CLI's rendering of
 * that flag in both human and --json output.
 */
import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// readFileSync is mocked so the command does not touch the filesystem.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => Buffer.from("file-contents")),
  writeFileSync: vi.fn(),
}));

const mockPut = vi.fn();
vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: () => ({
    client: {},
    config: { project_id: "proj-abc" },
    artifact: { put: mockPut },
  }),
}));

const loadCommand = async () => {
  const mod = await import("../../commands/artifact");
  return mod.default;
};

function getSubCommand(cmd: CommandDef, name: string): CommandDef {
  const subs = cmd.subCommands;
  if (!subs || typeof subs === "function" || subs instanceof Promise) {
    throw new Error("subCommands is not a plain object on command");
  }
  const sub = (subs as SubCommandsDef)[name];
  if (!sub || typeof sub === "function" || sub instanceof Promise) {
    throw new Error(`subCommand "${name}" is not a plain CommandDef`);
  }
  return sub;
}

async function runCmd(
  cmd: CommandDef,
  args: Record<string, unknown>,
): Promise<void> {
  if (!cmd.run) throw new Error("No run function");
  type RunFn = (ctx: {
    rawArgs: string[];
    args: Record<string, unknown> & { _: string[] };
    cmd: CommandDef;
  }) => void | Promise<void>;
  await (cmd.run as RunFn)({ rawArgs: [], args: { _: [], ...args }, cmd });
}

describe("artifact put output", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints "Uploaded" for a fresh artifact', async () => {
    mockPut.mockResolvedValue({
      key: "produced/T-1/abc.md",
      bytes: 42,
      deduplicated: false,
    });
    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "put"), {
      file: "plan.md",
      kind: "plan",
      json: false,
    });
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toContain("Uploaded artifact");
    expect(out).not.toContain("Deduplicated");
  });

  it('prints "Deduplicated" when the backend reports a dedup', async () => {
    mockPut.mockResolvedValue({
      key: "produced/T-1/abc.md",
      bytes: 42,
      deduplicated: true,
    });
    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "put"), {
      file: "plan.md",
      kind: "plan",
      json: false,
    });
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toContain("Deduplicated artifact");
    expect(out).not.toContain("Uploaded");
  });

  it("surfaces the deduplicated flag in --json output", async () => {
    mockPut.mockResolvedValue({
      key: "produced/T-1/abc.md",
      bytes: 42,
      deduplicated: true,
    });
    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "put"), {
      file: "plan.md",
      kind: "plan",
      json: true,
    });
    const payload = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(payload).toMatchObject({
      ok: true,
      key: "produced/T-1/abc.md",
      bytes: 42,
      deduplicated: true,
    });
  });
});
