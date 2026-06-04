import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock yocto-spinner so withSpinner doesn't hang in tests
vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

const mockList = vi.fn();
const mockGet = vi.fn();
const mockAcquire = vi.fn();

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn().mockReturnValue({
    client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    config: { project_id: "proj-test" },
    entity: {
      create: vi.fn(),
      get: mockGet,
      list: mockList,
      update: vi.fn(),
      archive: vi.fn(),
    },
    coordination: {
      acquire: mockAcquire,
      renew: vi.fn(),
      release: vi.fn(),
      state: vi.fn(),
      heartbeat: vi.fn(),
      listPresence: vi.fn(),
    },
    artifact: { put: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() },
  }),
}));

const loadCommand = async () => {
  const mod = await import("../../commands/task");
  return mod.default;
};

function getSubCommand(cmd: CommandDef, ...path: string[]): CommandDef {
  let current = cmd;
  for (const name of path) {
    const subs = current.subCommands;
    if (!subs || typeof subs === "function" || subs instanceof Promise) {
      throw new Error("subCommands is not a plain object on command");
    }
    const sub = (subs as SubCommandsDef)[name];
    if (!sub || typeof sub === "function" || sub instanceof Promise) {
      throw new Error(`subCommand "${name}" is not a plain CommandDef`);
    }
    current = sub;
  }
  return current;
}

async function runCmd(
  cmd: CommandDef,
  args: Record<string, unknown>,
): Promise<void> {
  if (!cmd.run) throw new Error("Command has no run function");
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

describe("tila task --json", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockList.mockReset();
    mockGet.mockReset();
    mockAcquire.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("task list", () => {
    it("outputs JSON with correct shape when --json", async () => {
      const entities = [
        {
          id: "T-1",
          type: "task",
          data: { title: "Task 1", status: "open" },
          created_at: 1700000000000,
          updated_at: 1700000000000,
        },
      ];
      mockList.mockResolvedValue(entities);
      const cmd = await loadCommand();
      const listCmd = getSubCommand(cmd, "list");
      await runCmd(listCmd, {
        status: undefined,
        parent: undefined,
        json: true,
      });

      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output).toHaveProperty("entities");
      expect(output).toHaveProperty("count", 1);
      expect(output).toHaveProperty("filters");
    });

    it("outputs human-readable text when no --json", async () => {
      const entities = [
        {
          id: "T-1",
          type: "task",
          data: { title: "Task 1", status: "open" },
          created_at: 1700000000000,
          updated_at: 1700000000000,
        },
      ];
      mockList.mockResolvedValue(entities);
      const cmd = await loadCommand();
      const listCmd = getSubCommand(cmd, "list");
      await runCmd(listCmd, {
        status: undefined,
        parent: undefined,
        json: false,
      });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("T-1"));
      // Verify it is NOT valid JSON (human-readable)
      expect(() => JSON.parse(logSpy.mock.calls[0][0] as string)).toThrow();
    });
  });

  describe("task show", () => {
    it("outputs JSON Entity when --json", async () => {
      const entity = {
        id: "T-1",
        type: "task",
        data: { title: "Test", status: "open" },
        created_at: 1700000000000,
        updated_at: 1700000000000,
      };
      mockGet.mockResolvedValue(entity);
      const cmd = await loadCommand();
      const showCmd = getSubCommand(cmd, "show");
      await runCmd(showCmd, { id: "T-1", json: true });

      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.id).toBe("T-1");
      expect(output.type).toBe("task");
    });

    it("outputs human-readable table when no --json (behavioral change)", async () => {
      const entity = {
        id: "T-1",
        type: "task",
        data: { title: "Test", status: "open" },
        created_at: 1700000000000,
        updated_at: 1700000000000,
      };
      mockGet.mockResolvedValue(entity);
      const cmd = await loadCommand();
      const showCmd = getSubCommand(cmd, "show");
      await runCmd(showCmd, { id: "T-1", json: false });

      // Should produce output containing entity details via renderTable
      // (console-table-printer calls console.log internally)
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe("task claim", () => {
    it("outputs JSON with fence as number and expires_at as ISO 8601 when --json", async () => {
      mockAcquire.mockResolvedValue({ fence: 42, expires_at: 1700000300000 });
      const cmd = await loadCommand();
      const claimCmd = getSubCommand(cmd, "claim");
      await runCmd(claimCmd, { id: "T-1", ttl: "300", json: true });

      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.ok).toBe(true);
      expect(output.acquired).toBe(true);
      expect(output.fence).toBe(42);
      expect(typeof output.fence).toBe("number");
      expect(output.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
