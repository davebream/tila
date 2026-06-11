import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs before anything imports it
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock yocto-spinner so withSpinner doesn't hang in tests
vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

// RecordBackend method mocks (the seam record.ts now drives).
const mockCreateRecord = vi.fn();
const mockSetRecord = vi.fn();
const mockGetRecord = vi.fn();
const mockPatchRecord = vi.fn();
const mockArchiveRecord = vi.fn();
const mockUnarchiveRecord = vi.fn();
const mockListRecords = vi.fn();
const mockListRecordHistory = vi.fn();
const mockListRecordTypesInUse = vi.fn();
// SchemaBackend.getCurrentSchema -- drives fetchRecordTypeDef.
const mockGetCurrentSchema = vi.fn();
// Remote-only client (snapshot preupload). Null toggled per-test for local mode.
const mockPostFormData = vi.fn();

let mockClient: { postFormData: typeof mockPostFormData } | null = {
  postFormData: mockPostFormData,
};

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: () => ({
    client: mockClient,
    config: { project_id: "proj-test" },
    machine: "test-machine",
    record: {
      createRecord: mockCreateRecord,
      setRecord: mockSetRecord,
      getRecord: mockGetRecord,
      patchRecord: mockPatchRecord,
      archiveRecord: mockArchiveRecord,
      unarchiveRecord: mockUnarchiveRecord,
      listRecords: mockListRecords,
      listRecordHistory: mockListRecordHistory,
      listRecordTypesInUse: mockListRecordTypesInUse,
    },
    schema: {
      getCurrentSchema: mockGetCurrentSchema,
    },
  }),
}));

const loadCommand = async () => {
  const mod = await import("../../commands/record");
  return mod.default;
};

function getSubCommand(cmd: CommandDef, ...path: string[]): CommandDef {
  let current = cmd;
  for (const name of path) {
    const subs = current.subCommands;
    if (!subs || typeof subs === "function" || subs instanceof Promise) {
      throw new Error("subCommands is not a plain object");
    }
    const sub = (subs as SubCommandsDef)[name];
    if (!sub || typeof sub === "function" || sub instanceof Promise) {
      throw new Error(`subCommand "${name}" not found`);
    }
    current = sub;
  }
  return current;
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
  await (cmd.run as RunFn)({
    rawArgs: [],
    args: { _: [], ...args },
    cmd,
  });
}

/** A RecordRow-shaped mutate result. */
function recordRow(over: Record<string, unknown> = {}) {
  return {
    type: "service",
    key: "api",
    value: { name: "test" },
    value_sha256: "abc",
    revision: 1,
    archived: 0,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    updated_by: "cli",
    tags: [],
    schema_version: 1,
    fence: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = { postFormData: mockPostFormData };
  // Default: no schema applied -> fetchRecordTypeDef returns null.
  mockGetCurrentSchema.mockResolvedValue({ version: null, definition: null });
});

// ---------------------------------------------------------------------------
// set subcommand
// ---------------------------------------------------------------------------

describe("tila record set", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ name: "test" }),
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("set with JSON file, no fence -> createRecord", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ name: "test" }),
    );
    mockCreateRecord.mockResolvedValue(recordRow());

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      json: false,
    });

    expect(mockCreateRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "service",
        key: "api",
        value: { name: "test" },
      }),
    );
    expect(logSpy.mock.calls[0][0]).toContain("Set record service/api");
  });

  it("set with JSON file, --fence 3 -> setRecord with fence", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ name: "updated" }),
    );
    mockSetRecord.mockResolvedValue(
      recordRow({ value: { name: "updated" }, revision: 2, fence: 4 }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      fence: "3",
      json: false,
    });

    expect(mockSetRecord).toHaveBeenCalledWith(
      expect.objectContaining({ value: { name: "updated" }, fence: 3 }),
    );
    expect(logSpy.mock.calls[0][0]).toContain("Set record service/api");
  });

  it("set with YAML file -> parses YAML to JSON", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "name: from-yaml\ncount: 42\n",
    );
    mockCreateRecord.mockResolvedValue(
      recordRow({ value: { name: "from-yaml", count: 42 } }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "service",
      key: "api",
      file: "/tmp/value.yaml",
      json: false,
    });

    expect(mockCreateRecord).toHaveBeenCalledWith(
      expect.objectContaining({ value: { name: "from-yaml", count: 42 } }),
    );
  });

  it("set with YAML file containing custom tag -> exits non-zero", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "name: !!python/object:__main__.Foo {bar: 1}\n",
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "service",
      key: "api",
      file: "/tmp/value.yaml",
      json: false,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/error/i);
  });

  it("set with snapshot-history type (remote) -> preupload artifact then createRecord", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ data: 1 }),
    );
    mockGetCurrentSchema.mockResolvedValue({
      version: 1,
      definition:
        'schema_version = 1\n[records.pipeline_config]\nhistory = "snapshot"\n',
    });
    mockPostFormData.mockResolvedValue({ key: "artifacts/snap-key" });
    mockCreateRecord.mockResolvedValue(
      recordRow({ type: "pipeline_config", key: "main", value: { data: 1 } }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "pipeline_config",
      key: "main",
      file: "/tmp/value.json",
      json: false,
    });

    expect(mockPostFormData).toHaveBeenCalled();
    expect(mockCreateRecord).toHaveBeenCalledWith(
      expect.objectContaining({ sourceArtifactKey: "artifacts/snap-key" }),
    );
  });

  it("set with snapshot-history type in LOCAL mode -> errors, no createRecord", async () => {
    mockClient = null; // local mode
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ data: 1 }),
    );
    mockGetCurrentSchema.mockResolvedValue({
      version: 1,
      definition:
        'schema_version = 1\n[records.pipeline_config]\nhistory = "snapshot"\n',
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "pipeline_config",
      key: "main",
      file: "/tmp/value.json",
      json: false,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(
      errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toMatch(/snapshot/i);
    expect(mockCreateRecord).not.toHaveBeenCalled();
    expect(mockPostFormData).not.toHaveBeenCalled();
  });

  it("set with non-snapshot type -> no preupload", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ data: 1 }),
    );
    mockGetCurrentSchema.mockResolvedValue({
      version: 1,
      definition: '[records.service]\nhistory = "revision"\n',
    });
    mockCreateRecord.mockResolvedValue(recordRow({ value: { data: 1 } }));

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      json: false,
    });

    expect(mockPostFormData).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// get subcommand
// ---------------------------------------------------------------------------

describe("tila record get", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("get -> fetches record and outputs JSON by default", async () => {
    mockGetRecord.mockResolvedValue(
      recordRow({ value: { host: "localhost" } }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "get");
    await runCmd(sub, { type: "service", key: "api", json: false });

    const output = logSpy.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual({ host: "localhost" });
  });

  it("get --format yaml -> outputs YAML", async () => {
    mockGetRecord.mockResolvedValue(
      recordRow({ value: { host: "localhost" } }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "get");
    await runCmd(sub, {
      type: "service",
      key: "api",
      format: "yaml",
      json: false,
    });

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain("host: localhost");
  });
});

// ---------------------------------------------------------------------------
// patch subcommand
// ---------------------------------------------------------------------------

describe("tila record patch", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("patch with --fence -> patchRecord", async () => {
    mockPatchRecord.mockResolvedValue(
      recordRow({ value: { owner: "platform" }, revision: 3, fence: 6 }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "patch");
    await runCmd(sub, {
      type: "service",
      key: "api",
      json: '{"owner":"platform"}',
      fence: "5",
    });

    expect(mockPatchRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "service",
        key: "api",
        patch: { owner: "platform" },
        fence: 5,
      }),
    );
    expect(logSpy.mock.calls[0][0]).toContain("Patched record service/api");
  });

  it("patch without --fence -> exits non-zero with error", async () => {
    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "patch");
    await runCmd(sub, {
      type: "service",
      key: "api",
      json: '{"owner":"platform"}',
      // fence intentionally omitted
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/fence/i);
  });
});

// ---------------------------------------------------------------------------
// list subcommand
// ---------------------------------------------------------------------------

describe("tila record list", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("list -> listRecords with table output", async () => {
    mockListRecords.mockResolvedValue({
      items: [
        {
          type: "service",
          key: "api",
          revision: 2,
          updated_at: 1700000000000,
          updated_by: "cli",
          archived: 0,
          tags: [],
        },
      ],
      total: 1,
      next_cursor: null,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "list");
    await runCmd(sub, { type: "service", json: false });

    expect(mockListRecords).toHaveBeenCalledWith(
      expect.objectContaining({ type: "service" }),
    );
  });

  it("list --json -> prints full envelope", async () => {
    mockListRecords.mockResolvedValue({
      items: [],
      total: 0,
      next_cursor: null,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "list");
    await runCmd(sub, { type: "service", json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.ok).toBe(true);
    expect(output.items).toEqual([]);
    expect(output.meta).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// history subcommand
// ---------------------------------------------------------------------------

describe("tila record history", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("history -> default limit=20 and includeValues=false", async () => {
    mockListRecordHistory.mockResolvedValue({
      items: [],
      total: 0,
      next_cursor: null,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "history");
    await runCmd(sub, { type: "service", key: "api", json: false });

    expect(mockListRecordHistory).toHaveBeenCalledWith("service", "api", {
      limit: 20,
      includeValues: false,
    });
  });

  it("history --values --limit 5 -> correct options", async () => {
    mockListRecordHistory.mockResolvedValue({
      items: [],
      total: 0,
      next_cursor: null,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "history");
    await runCmd(sub, {
      type: "service",
      key: "api",
      values: true,
      limit: "5",
      json: false,
    });

    expect(mockListRecordHistory).toHaveBeenCalledWith("service", "api", {
      limit: 5,
      includeValues: true,
    });
  });
});

// ---------------------------------------------------------------------------
// archive / unarchive subcommands
// ---------------------------------------------------------------------------

describe("tila record archive/unarchive", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("archive --fence 7 -> archiveRecord", async () => {
    mockArchiveRecord.mockResolvedValue(
      recordRow({ value: {}, revision: 4, archived: 1, fence: 8 }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "archive");
    await runCmd(sub, {
      type: "service",
      key: "api",
      fence: "7",
      json: false,
    });

    expect(mockArchiveRecord).toHaveBeenCalledWith({
      type: "service",
      key: "api",
      fence: 7,
    });
    expect(logSpy.mock.calls[0][0]).toContain("Archived record service/api");
  });

  it("unarchive --fence 8 -> unarchiveRecord", async () => {
    mockUnarchiveRecord.mockResolvedValue(
      recordRow({ value: {}, revision: 5, archived: 0, fence: 9 }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "unarchive");
    await runCmd(sub, {
      type: "service",
      key: "api",
      fence: "8",
      json: false,
    });

    expect(mockUnarchiveRecord).toHaveBeenCalledWith({
      type: "service",
      key: "api",
      fence: 8,
    });
    expect(logSpy.mock.calls[0][0]).toContain("Unarchived record service/api");
  });
});

// ---------------------------------------------------------------------------
// export subcommand
// ---------------------------------------------------------------------------

describe("tila record export", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fs = await import("node:fs");
    (fs.mkdirSync as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (fs.writeFileSync as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("export -> lists then gets each record, writes files", async () => {
    const fs = await import("node:fs");
    mockListRecords.mockResolvedValue({
      items: [
        {
          type: "service",
          key: "api",
          revision: 1,
          updated_at: 1700000000000,
          updated_by: "cli",
          archived: 0,
          tags: [],
        },
      ],
      total: 1,
      next_cursor: null,
    });
    mockGetRecord.mockResolvedValue(
      recordRow({ value: { host: "localhost" } }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "export");
    await runCmd(sub, { type: "service", "output-dir": "./out", all: false });

    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(logSpy.mock.calls[0][0]).toContain("Exported service/api");
  });

  it("export with slash key -> nested directory", async () => {
    const fs = await import("node:fs");
    mockListRecords.mockResolvedValue({
      items: [
        {
          type: "service",
          key: "api/staging",
          revision: 1,
          updated_at: 1700000000000,
          updated_by: "cli",
          archived: 0,
          tags: [],
        },
      ],
      total: 1,
      next_cursor: null,
    });
    mockGetRecord.mockResolvedValue(
      recordRow({ key: "api/staging", value: { env: "staging" } }),
    );

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "export");
    await runCmd(sub, { type: "service", "output-dir": "./out", all: false });

    const mkdirCalls = (fs.mkdirSync as ReturnType<typeof vi.fn>).mock.calls;
    const nestedDir = mkdirCalls.find((call: unknown[]) =>
      (call[0] as string).includes("api"),
    );
    expect(nestedDir).toBeDefined();
    expect(logSpy.mock.calls[0][0]).toContain("service/api/staging");
  });
});

// ---------------------------------------------------------------------------
// types subcommand
// ---------------------------------------------------------------------------

describe("tila record types", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("types -> lists types from the backend", async () => {
    mockListRecordTypesInUse.mockResolvedValue(["pipeline_config", "service"]);

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "types");
    await runCmd(sub, { json: false, "in-use": false });

    expect(logSpy).toHaveBeenCalledWith("pipeline_config");
    expect(logSpy).toHaveBeenCalledWith("service");
  });

  it("types --json -> prints envelope", async () => {
    mockListRecordTypesInUse.mockResolvedValue(["service"]);

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "types");
    await runCmd(sub, { json: true, "in-use": false });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.ok).toBe(true);
    expect(output.types).toEqual(["service"]);
  });

  // Regression: a declared-but-unused type must appear in the default (merged)
  // listing but NOT in --in-use. This is the cross-backend parity bug — here
  // exercised against the MOCKED remote backend, whose listRecordTypesInUse()
  // returns the in-use subset only.
  it("types (default) -> MERGES schema-declared types with in-use types", async () => {
    mockGetCurrentSchema.mockResolvedValue({
      version: 1,
      definition:
        'schema_version = 1\n[records.declared_only.fields.value]\ntype = "string"\n[records.service.fields.value]\ntype = "string"\n',
    });
    mockListRecordTypesInUse.mockResolvedValue(["service"]); // only service in use

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "types");
    await runCmd(sub, { json: true, "in-use": false });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    // declared_only is declared but unused -> still listed in merged view.
    expect(output.types).toEqual(["declared_only", "service"]);
  });

  it("types --in-use -> EXCLUDES declared-but-unused types", async () => {
    mockGetCurrentSchema.mockResolvedValue({
      version: 1,
      definition:
        'schema_version = 1\n[records.declared_only.fields.value]\ntype = "string"\n[records.service.fields.value]\ntype = "string"\n',
    });
    mockListRecordTypesInUse.mockResolvedValue(["service"]);

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "types");
    await runCmd(sub, { json: true, "in-use": true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    // Only types with active records -> declared_only is omitted.
    expect(output.types).toEqual(["service"]);
  });
});
