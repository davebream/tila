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

const mockCreate = vi.fn();
const mockAddRelationship = vi.fn();
const mockListRelationships = vi.fn();
const mockRemoveRelationship = vi.fn();

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn().mockImplementation(() => ({
    client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    config: { project_id: "proj-test" },
    entity: {
      create: mockCreate,
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      addRelationship: mockAddRelationship,
      listRelationships: mockListRelationships,
      removeRelationship: mockRemoveRelationship,
    },
    coordination: {
      acquire: vi.fn(),
      renew: vi.fn(),
      release: vi.fn(),
      state: vi.fn(),
      heartbeat: vi.fn(),
      listPresence: vi.fn(),
    },
    artifact: { put: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() },
  })),
}));

// Import the real TilaApiError so instanceof checks work
import { TilaApiError } from "tila-sdk";

// Reset module cache between tests so mocks apply
const loadCommand = async () => {
  const mod = await import("../../commands/task");
  return mod.default;
};

function getSubCommand(cmd: CommandDef, ...path: string[]): CommandDef {
  let current = cmd;
  for (const name of path) {
    const subs = current.subCommands;
    if (!subs || typeof subs === "function" || subs instanceof Promise) {
      throw new Error(`subCommands is not a plain object at "${name}"`);
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

describe("task relationship commands", () => {
  // Use broad types to avoid complex MockInstance overload matching
  let logSpy: { mock: { calls: unknown[][] }; mockRestore(): void };
  let errorSpy: { mock: { calls: unknown[][] }; mockRestore(): void };
  let exitSpy: { mockRestore(): void };
  let stderrSpy: { mock: { calls: unknown[][] }; mockRestore(): void };

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`);
      });
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    mockCreate.mockReset();
    mockAddRelationship.mockReset();
    mockListRelationships.mockReset();
    mockRemoveRelationship.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Task 7 tests: relationship add/list/remove
  // -----------------------------------------------------------------------

  describe("type alias map + invalid-type fail-fast", () => {
    it("maps 'parent' alias to 'parent-child'", async () => {
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, {
        from: "A",
        to: "B",
        type: "parent",
        json: false,
      });
      expect(mockAddRelationship).toHaveBeenCalledWith({
        from_id: "A",
        to_id: "B",
        type: "parent-child",
      });
    });

    it("maps 'block' alias to 'blocks'", async () => {
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, {
        from: "A",
        to: "B",
        type: "block",
        json: false,
      });
      expect(mockAddRelationship).toHaveBeenCalledWith({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
    });

    it("fails fast with exit 1 and lists canonical values for invalid type", async () => {
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await expect(
        runCmd(addCmd, {
          from: "A",
          to: "B",
          type: "invalid-type",
          json: false,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("parent-child"),
      );
      expect(mockAddRelationship).not.toHaveBeenCalled();
    });

    it("fails fast with JSON error for invalid type in --json mode", async () => {
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      // printJsonError calls process.exit(1) internally — expect the throw
      await expect(
        runCmd(addCmd, {
          from: "A",
          to: "B",
          type: "invalid-type",
          json: true,
        }),
      ).rejects.toThrow("process.exit(1)");
      // printJsonError writes { ok:false, code, message } to stderr via console.error
      const output = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(output.code).toBe("validation-error");
      expect(output.message).toContain("invalid-type");
      expect(mockAddRelationship).not.toHaveBeenCalled();
    });

    it("accepts canonical type 'blocks' unchanged", async () => {
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, {
        from: "A",
        to: "B",
        type: "blocks",
        json: false,
      });
      expect(mockAddRelationship).toHaveBeenCalledWith({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
    });

    it("accepts 'PARENT' (case-insensitive) alias mapping to 'parent-child'", async () => {
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, {
        from: "A",
        to: "B",
        type: "PARENT",
        json: false,
      });
      expect(mockAddRelationship).toHaveBeenCalledWith({
        from_id: "A",
        to_id: "B",
        type: "parent-child",
      });
    });
  });

  describe("relationship add", () => {
    it("prints 'Added: A blocks B' when created:true", async () => {
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, { from: "A", to: "B", type: "blocks", json: false });
      expect(logSpy).toHaveBeenCalledWith("Added: A blocks B");
    });

    it("prints 'Already linked: A blocks B' when created:false", async () => {
      mockAddRelationship.mockResolvedValue({ created: false });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, { from: "A", to: "B", type: "blocks", json: false });
      expect(logSpy).toHaveBeenCalledWith("Already linked: A blocks B");
    });

    it("exits 0 in both created:true and created:false cases", async () => {
      mockAddRelationship.mockResolvedValue({ created: false });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      // Should NOT throw (exit 0 means no process.exit call)
      await expect(
        runCmd(addCmd, { from: "A", to: "B", type: "blocks", json: false }),
      ).resolves.toBeUndefined();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("outputs JSON with ok/from/to/type/created when --json and created:true", async () => {
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, { from: "A", to: "B", type: "blocks", json: true });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output).toEqual({
        ok: true,
        from: "A",
        to: "B",
        type: "blocks",
        created: true,
      });
    });

    it("outputs JSON with created:false when --json and already linked", async () => {
      mockAddRelationship.mockResolvedValue({ created: false });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, { from: "A", to: "B", type: "blocks", json: true });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output).toEqual({
        ok: true,
        from: "A",
        to: "B",
        type: "blocks",
        created: false,
      });
    });

    it("prints correct verb for parent-child type", async () => {
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "relationship", "add");
      await runCmd(addCmd, {
        from: "parent",
        to: "child",
        type: "parent-child",
        json: false,
      });
      expect(logSpy).toHaveBeenCalledWith("Added: parent is parent of child");
    });
  });

  describe("relationship list", () => {
    it("prints 'No relationships found.' when empty (human mode)", async () => {
      mockListRelationships.mockResolvedValue([]);
      const cmd = await loadCommand();
      const listCmd = getSubCommand(cmd, "relationship", "list");
      await runCmd(listCmd, { json: false });
      expect(logSpy).toHaveBeenCalledWith("No relationships found.");
    });

    it("outputs {relationships:[], count:0} when empty and --json", async () => {
      mockListRelationships.mockResolvedValue([]);
      const cmd = await loadCommand();
      const listCmd = getSubCommand(cmd, "relationship", "list");
      await runCmd(listCmd, { json: true });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output).toEqual({ relationships: [], count: 0 });
    });

    it("renders table for populated list (human mode)", async () => {
      const rels = [
        {
          from_id: "A",
          to_id: "B",
          type: "blocks",
          schema_version: 1,
          created_at: 1700000000000,
        },
      ];
      mockListRelationships.mockResolvedValue(rels);
      const cmd = await loadCommand();
      const listCmd = getSubCommand(cmd, "relationship", "list");
      await runCmd(listCmd, { json: false });
      // renderTable calls console.log internally
      expect(logSpy).toHaveBeenCalled();
      // The log should NOT be "No relationships found."
      expect(logSpy).not.toHaveBeenCalledWith("No relationships found.");
    });

    it("outputs JSON with relationships array and count when --json", async () => {
      const rels = [
        {
          from_id: "A",
          to_id: "B",
          type: "blocks",
          schema_version: 1,
          created_at: 1700000000000,
        },
      ];
      mockListRelationships.mockResolvedValue(rels);
      const cmd = await loadCommand();
      const listCmd = getSubCommand(cmd, "relationship", "list");
      await runCmd(listCmd, { json: true });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.count).toBe(1);
      expect(output.relationships).toHaveLength(1);
      expect(output.relationships[0].from_id).toBe("A");
      // created_at should be ISO string (tsToIso applied)
      expect(typeof output.relationships[0].created_at).toBe("string");
    });

    it("passes from/to/type filters to backend", async () => {
      mockListRelationships.mockResolvedValue([]);
      const cmd = await loadCommand();
      const listCmd = getSubCommand(cmd, "relationship", "list");
      await runCmd(listCmd, {
        from: "A",
        to: "B",
        type: "blocks",
        json: false,
      });
      expect(mockListRelationships).toHaveBeenCalledWith({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });
    });

    it("fails fast for invalid type filter", async () => {
      const cmd = await loadCommand();
      const listCmd = getSubCommand(cmd, "relationship", "list");
      await expect(
        runCmd(listCmd, { type: "bogus", json: false }),
      ).rejects.toThrow("process.exit(1)");
      expect(mockListRelationships).not.toHaveBeenCalled();
    });
  });

  describe("relationship remove", () => {
    it("prints 'Removed: A blocks B' when removed:true", async () => {
      mockRemoveRelationship.mockResolvedValue({ removed: true });
      const cmd = await loadCommand();
      const removeCmd = getSubCommand(cmd, "relationship", "remove");
      await runCmd(removeCmd, {
        from: "A",
        to: "B",
        type: "blocks",
        json: false,
      });
      expect(logSpy).toHaveBeenCalledWith("Removed: A blocks B");
    });

    it("prints 'Not found: A blocks B' when removed:false", async () => {
      mockRemoveRelationship.mockResolvedValue({ removed: false });
      const cmd = await loadCommand();
      const removeCmd = getSubCommand(cmd, "relationship", "remove");
      await runCmd(removeCmd, {
        from: "A",
        to: "B",
        type: "blocks",
        json: false,
      });
      expect(logSpy).toHaveBeenCalledWith("Not found: A blocks B");
    });

    it("exits 0 for both removed:true and removed:false", async () => {
      mockRemoveRelationship.mockResolvedValue({ removed: false });
      const cmd = await loadCommand();
      const removeCmd = getSubCommand(cmd, "relationship", "remove");
      await expect(
        runCmd(removeCmd, { from: "A", to: "B", type: "blocks", json: false }),
      ).resolves.toBeUndefined();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("outputs JSON {ok,from,to,type,removed} when --json and removed:true", async () => {
      mockRemoveRelationship.mockResolvedValue({ removed: true });
      const cmd = await loadCommand();
      const removeCmd = getSubCommand(cmd, "relationship", "remove");
      await runCmd(removeCmd, {
        from: "A",
        to: "B",
        type: "blocks",
        json: true,
      });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output).toEqual({
        ok: true,
        from: "A",
        to: "B",
        type: "blocks",
        removed: true,
      });
    });

    it("outputs JSON with removed:false when --json and not found", async () => {
      mockRemoveRelationship.mockResolvedValue({ removed: false });
      const cmd = await loadCommand();
      const removeCmd = getSubCommand(cmd, "relationship", "remove");
      await runCmd(removeCmd, {
        from: "A",
        to: "B",
        type: "blocks",
        json: true,
      });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output).toEqual({
        ok: true,
        from: "A",
        to: "B",
        type: "blocks",
        removed: false,
      });
    });

    it("fails fast for invalid type", async () => {
      const cmd = await loadCommand();
      const removeCmd = getSubCommand(cmd, "relationship", "remove");
      await expect(
        runCmd(removeCmd, { from: "A", to: "B", type: "bad", json: false }),
      ).rejects.toThrow("process.exit(1)");
      expect(mockRemoveRelationship).not.toHaveBeenCalled();
    });
  });

  describe("rel alias", () => {
    it("rel subcommand group exists and shares the same add/list/remove commands", async () => {
      const cmd = await loadCommand();
      const subs = cmd.subCommands as SubCommandsDef;
      expect(subs).toHaveProperty("rel");
      // Both keys should point to the same command object
      expect(subs.relationship).toBe(subs.rel);
    });

    it("rel add works the same as relationship add", async () => {
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const addCmd = getSubCommand(cmd, "rel", "add");
      await runCmd(addCmd, { from: "X", to: "Y", type: "blocks", json: false });
      expect(logSpy).toHaveBeenCalledWith("Added: X blocks Y");
    });
  });

  // -----------------------------------------------------------------------
  // Task 8 tests: task new --id/--type/--link-parent
  // -----------------------------------------------------------------------

  describe("task new --id/--type", () => {
    it("uses provided --id and --type", async () => {
      mockCreate.mockResolvedValue({
        id: "epic.x",
        type: "epic",
        data: {},
        created_at: 0,
        updated_at: 0,
      });
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await runCmd(newCmd, {
        title: "My Epic",
        id: "epic.x",
        type: "epic",
        json: true,
        "link-parent": false,
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "epic.x", type: "epic" }),
      );
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.ok).toBe(true);
      expect(output.id).toBe("epic.x");
      expect(output.type).toBe("epic");
      expect(output.title).toBe("My Epic");
    });

    it("uses auto-generated T-<base36> id when --id omitted", async () => {
      mockCreate.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          id,
          type: "task",
          data: {},
          created_at: 0,
          updated_at: 0,
        }),
      );
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await runCmd(newCmd, {
        title: "Auto task",
        json: true,
        "link-parent": false,
      });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.id).toMatch(/^T-/);
      expect(output.type).toBe("task");
    });

    it("defaults type to 'task' when --type omitted", async () => {
      mockCreate.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          id,
          type: "task",
          data: {},
          created_at: 0,
          updated_at: 0,
        }),
      );
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await runCmd(newCmd, {
        title: "Default type",
        id: "my-task",
        json: false,
        "link-parent": false,
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task" }),
      );
    });

    it("rejects id containing '/' with exit 1 before network call", async () => {
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await expect(
        runCmd(newCmd, {
          title: "Bad id",
          id: "a/b",
          json: false,
          "link-parent": false,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Task id must not contain '/'"),
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("rejects whitespace-only id with exit 1", async () => {
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await expect(
        runCmd(newCmd, {
          title: "Bad id",
          id: "   ",
          json: false,
          "link-parent": false,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("maps 409 already-exists error to 'Task <id> already exists.'", async () => {
      mockCreate.mockRejectedValue(
        // biome-ignore lint/suspicious/noExplicitAny: test uses a non-registered wire code
        new TilaApiError(409, "already-exists" as any, "conflict", false),
      );
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await expect(
        runCmd(newCmd, {
          title: "Dup",
          id: "epic.x",
          json: false,
          "link-parent": false,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(errorSpy).toHaveBeenCalledWith("Task epic.x already exists.");
    });

    it("outputs JSON error for duplicate id with --json", async () => {
      mockCreate.mockRejectedValue(
        // biome-ignore lint/suspicious/noExplicitAny: test uses a non-registered wire code
        new TilaApiError(409, "already-exists" as any, "conflict", false),
      );
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      // printJsonError calls process.exit(1) internally — expect the throw
      await expect(
        runCmd(newCmd, {
          title: "Dup",
          id: "epic.x",
          json: true,
          "link-parent": false,
        }),
      ).rejects.toThrow("process.exit(1)");
      // printJsonError writes { ok:false, code, message } to stderr via console.error
      const output = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(output.code).toBe("already-exists");
      expect(output.message).toContain("epic.x");
    });

    it("plain success --json shape is {ok,id,type,title} (no parent)", async () => {
      mockCreate.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          id,
          type: "task",
          data: {},
          created_at: 0,
          updated_at: 0,
        }),
      );
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await runCmd(newCmd, {
        title: "T",
        id: "my-task",
        type: "task",
        json: true,
        "link-parent": false,
      });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(Object.keys(output).sort()).toEqual(
        ["id", "ok", "title", "type"].sort(),
      );
    });

    it("plain success --json includes parent when --parent is set", async () => {
      mockCreate.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          id,
          type: "task",
          data: {},
          created_at: 0,
          updated_at: 0,
        }),
      );
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await runCmd(newCmd, {
        title: "T",
        id: "child",
        type: "task",
        parent: "epic.x",
        json: true,
        "link-parent": false,
      });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.parent).toBe("epic.x");
    });
  });

  describe("task new --link-parent", () => {
    it("--link-parent without --parent exits 1 before create call", async () => {
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await expect(
        runCmd(newCmd, {
          title: "T",
          id: "task.1",
          "link-parent": true,
          json: false,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(errorSpy).toHaveBeenCalledWith("--link-parent requires --parent");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("--link-parent success creates task and relationship, --json {ok,linked:true}", async () => {
      mockCreate.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          id,
          type: "task",
          data: {},
          created_at: 0,
          updated_at: 0,
        }),
      );
      mockAddRelationship.mockResolvedValue({ created: true });
      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await runCmd(newCmd, {
        title: "Child",
        id: "child.1",
        type: "task",
        parent: "epic.x",
        "link-parent": true,
        json: true,
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "child.1" }),
      );
      expect(mockAddRelationship).toHaveBeenCalledWith({
        from_id: "epic.x",
        to_id: "child.1",
        type: "parent-child",
      });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output).toMatchObject({
        ok: true,
        id: "child.1",
        type: "task",
        title: "Child",
        parent: "epic.x",
        linked: true,
      });
    });

    it("--link-parent partial failure: task created, link fails, exits 1 with PARTIAL json", async () => {
      mockCreate.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          id,
          type: "task",
          data: {},
          created_at: 0,
          updated_at: 0,
        }),
      );
      const linkError = new TilaApiError(
        422,
        // biome-ignore lint/suspicious/noExplicitAny: test uses a non-registered wire code
        "leaf-rejection" as any,
        "Leaf cannot be parent",
        false,
      );
      mockAddRelationship.mockRejectedValue(linkError);

      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await expect(
        runCmd(newCmd, {
          title: "Child",
          id: "child.1",
          type: "task",
          parent: "epic.x",
          "link-parent": true,
          json: true,
        }),
      ).rejects.toThrow("process.exit(1)");

      // Task was created
      expect(mockCreate).toHaveBeenCalled();
      // Stderr got the partial JSON
      const stderrOutput = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(stderrOutput.trim());
      // Verify exact key set
      expect(Object.keys(parsed).sort()).toEqual(
        ["error", "id", "linked", "ok", "parent", "title", "type"].sort(),
      );
      expect(parsed.ok).toBe(false);
      expect(parsed.linked).toBe(false);
      expect(parsed.id).toBe("child.1");
      expect(parsed.parent).toBe("epic.x");
      expect(parsed.error.code).toBe("leaf-rejection");
      expect(parsed.error.message).toBeTruthy();
    });

    it("--link-parent partial failure human output mentions re-link hint", async () => {
      mockCreate.mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({
          id,
          type: "task",
          data: {},
          created_at: 0,
          updated_at: 0,
        }),
      );
      mockAddRelationship.mockRejectedValue(new Error("Link failed"));

      const cmd = await loadCommand();
      const newCmd = getSubCommand(cmd, "new");
      await expect(
        runCmd(newCmd, {
          title: "Child",
          id: "child.1",
          type: "task",
          parent: "epic.x",
          "link-parent": true,
          json: false,
        }),
      ).rejects.toThrow("process.exit(1)");

      const errMsg = errorSpy.mock.calls[0][0] as string;
      expect(errMsg).toContain("Re-link with: tila task relationship add");
      expect(errMsg).toContain("epic.x");
      expect(errMsg).toContain("child.1");
    });
  });
});
