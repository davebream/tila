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

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockPatch = vi.fn();
const mockPostFormData = vi.fn();

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: vi.fn().mockReturnValue({
    client: {
      get: mockGet,
      post: mockPost,
      put: mockPut,
      patch: mockPatch,
      postFormData: mockPostFormData,
    },
    config: { project_id: "proj-test" },
    entity: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
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

// ---------------------------------------------------------------------------
// set subcommand
// ---------------------------------------------------------------------------

describe("tila record set", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const fs = await import("node:fs");
    // Default: readFileSync returns JSON content (overridden per test)
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ name: "test" }),
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("set with JSON file, no fence -> POST to create", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ name: "test" }),
    );
    // fetchRecordTypeDef fails (no schema)
    mockGet.mockRejectedValueOnce(new Error("no schema"));
    mockPost.mockResolvedValue({
      ok: true,
      record: {
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
      },
      fence: 1,
      revision: 1,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      json: false,
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/projects/proj-test/records/service",
      expect.objectContaining({ key: "api", value: { name: "test" } }),
      expect.any(Object),
    );
    expect(logSpy.mock.calls[0][0]).toContain("Set record service/api");
  });

  it("set with JSON file, --fence 3 -> PUT to update", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ name: "updated" }),
    );
    mockGet.mockRejectedValueOnce(new Error("no schema"));
    mockPut.mockResolvedValue({
      ok: true,
      record: {
        type: "service",
        key: "api",
        value: { name: "updated" },
        value_sha256: "abc",
        revision: 2,
        archived: 0,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        updated_by: "cli",
        tags: [],
        schema_version: 1,
      },
      fence: 4,
      revision: 2,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      fence: "3",
      json: false,
    });

    expect(mockPut).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/api",
      expect.objectContaining({ value: { name: "updated" }, fence: 3 }),
      expect.any(Object),
    );
    expect(logSpy.mock.calls[0][0]).toContain("Set record service/api");
  });

  it("set with YAML file -> parses YAML to JSON", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      "name: from-yaml\ncount: 42\n",
    );
    mockGet.mockRejectedValueOnce(new Error("no schema"));
    mockPost.mockResolvedValue({
      ok: true,
      record: {
        type: "service",
        key: "api",
        value: { name: "from-yaml", count: 42 },
        value_sha256: "abc",
        revision: 1,
        archived: 0,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        updated_by: "cli",
        tags: [],
        schema_version: 1,
      },
      fence: 1,
      revision: 1,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "service",
      key: "api",
      file: "/tmp/value.yaml",
      json: false,
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/projects/proj-test/records/service",
      expect.objectContaining({ value: { name: "from-yaml", count: 42 } }),
      expect.any(Object),
    );
  });

  it("set with YAML file containing custom tag -> exits non-zero", async () => {
    const fs = await import("node:fs");
    // yaml.parse with { schema: "json" } rejects custom tags like !!python/object
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

  it("set with snapshot-history type -> preupload artifact", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ data: 1 }),
    );
    // fetchRecordTypeDef returns snapshot type
    mockGet.mockResolvedValueOnce({
      ok: true,
      schema: {
        definition:
          'schema_version = 1\n[records.pipeline_config]\nhistory = "snapshot"\n',
        version: 1,
      },
      version: 1,
    });
    mockPostFormData.mockResolvedValue({ key: "artifacts/snap-key" });
    mockPost.mockResolvedValue({
      ok: true,
      record: {
        type: "pipeline_config",
        key: "main",
        value: { data: 1 },
        value_sha256: "abc",
        revision: 1,
        archived: 0,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        updated_by: "cli",
        tags: [],
        schema_version: 1,
      },
      fence: 1,
      revision: 1,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "set");
    await runCmd(sub, {
      type: "pipeline_config",
      key: "main",
      file: "/tmp/value.json",
      json: false,
    });

    expect(mockPostFormData).toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledWith(
      "/projects/proj-test/records/pipeline_config",
      expect.objectContaining({ source_artifact_key: "artifacts/snap-key" }),
      expect.any(Object),
    );
  });

  it("set with non-snapshot type -> no preupload", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ data: 1 }),
    );
    // fetchRecordTypeDef returns revision type
    mockGet.mockResolvedValueOnce({
      ok: true,
      schema: {
        definition: '[records.service]\nhistory = "revision"\n',
        version: 1,
      },
      version: 1,
    });
    mockPost.mockResolvedValue({
      ok: true,
      record: {
        type: "service",
        key: "api",
        value: { data: 1 },
        value_sha256: "abc",
        revision: 1,
        archived: 0,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        updated_by: "cli",
        tags: [],
        schema_version: 1,
      },
      fence: 1,
      revision: 1,
    });

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
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("get -> fetches record and outputs JSON by default", async () => {
    mockGet
      .mockResolvedValueOnce({
        ok: true,
        record: {
          type: "service",
          key: "api",
          value: { host: "localhost" },
          value_sha256: "abc123",
          revision: 1,
          archived: 0,
          created_at: 1700000000000,
          updated_at: 1700000000000,
          updated_by: "cli",
          tags: [],
          schema_version: 1,
        },
        fence: 1,
      })
      .mockRejectedValueOnce(new Error("no schema")); // fetchRecordTypeDef

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "get");
    await runCmd(sub, { type: "service", key: "api", json: false });

    const output = logSpy.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual({ host: "localhost" });
  });

  it("get --format yaml -> outputs YAML", async () => {
    mockGet.mockResolvedValueOnce({
      ok: true,
      record: {
        type: "service",
        key: "api",
        value: { host: "localhost" },
        value_sha256: "abc123",
        revision: 1,
        archived: 0,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        updated_by: "cli",
        tags: [],
        schema_version: 1,
      },
      fence: 1,
    });

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
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("patch with --fence -> sends PATCH request", async () => {
    mockPatch.mockResolvedValue({
      ok: true,
      record: {
        type: "service",
        key: "api",
        value: { owner: "platform" },
        value_sha256: "abc",
        revision: 3,
        archived: 0,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        updated_by: "cli",
        tags: [],
        schema_version: 1,
      },
      fence: 6,
      revision: 3,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "patch");
    await runCmd(sub, {
      type: "service",
      key: "api",
      json: '{"owner":"platform"}',
      fence: "5",
    });

    expect(mockPatch).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/api",
      { patch: { owner: "platform" }, fence: 5 },
      expect.any(Object),
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("list -> GET request with table output", async () => {
    mockGet.mockResolvedValue({
      ok: true,
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
      meta: { total: 1, limit: 200, next_cursor: null },
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "list");
    await runCmd(sub, { type: "service", json: false });

    expect(mockGet).toHaveBeenCalledWith(
      "/projects/proj-test/records/service",
      expect.any(Object),
    );
  });

  it("list --json -> prints full envelope", async () => {
    const envelope = {
      ok: true,
      items: [],
      meta: { total: 0, limit: 200, next_cursor: null },
    };
    mockGet.mockResolvedValue(envelope);

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
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("history -> GET with default limit=20 and values=false", async () => {
    mockGet.mockResolvedValue({
      ok: true,
      items: [],
      meta: { total: 0, limit: 20, next_cursor: null },
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "history");
    await runCmd(sub, { type: "service", key: "api", json: false });

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining("limit=20"),
      expect.any(Object),
    );
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining("values=false"),
      expect.any(Object),
    );
  });

  it("history --values --limit 5 -> correct query params", async () => {
    mockGet.mockResolvedValue({
      ok: true,
      items: [],
      meta: { total: 0, limit: 5, next_cursor: null },
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

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining("limit=5"),
      expect.any(Object),
    );
    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining("values=true"),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// archive / unarchive subcommands
// ---------------------------------------------------------------------------

describe("tila record archive/unarchive", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("archive --fence 7 -> POST to ~/archive", async () => {
    mockPost.mockResolvedValue({
      ok: true,
      record: {
        type: "service",
        key: "api",
        value: {},
        value_sha256: "abc",
        revision: 4,
        archived: 1,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        updated_by: "cli",
        tags: [],
        schema_version: 1,
      },
      fence: 8,
      revision: 4,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "archive");
    await runCmd(sub, {
      type: "service",
      key: "api",
      fence: "7",
      json: false,
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/~/archive/api",
      { fence: 7 },
      expect.any(Object),
    );
    expect(logSpy.mock.calls[0][0]).toContain("Archived record service/api");
  });

  it("unarchive --fence 8 -> POST to ~/unarchive", async () => {
    mockPost.mockResolvedValue({
      ok: true,
      record: {
        type: "service",
        key: "api",
        value: {},
        value_sha256: "abc",
        revision: 5,
        archived: 0,
        created_at: 1700000000000,
        updated_at: 1700000000000,
        updated_by: "cli",
        tags: [],
        schema_version: 1,
      },
      fence: 9,
      revision: 5,
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "unarchive");
    await runCmd(sub, {
      type: "service",
      key: "api",
      fence: "8",
      json: false,
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/~/unarchive/api",
      { fence: 8 },
      expect.any(Object),
    );
    expect(logSpy.mock.calls[0][0]).toContain("Unarchived record service/api");
  });
});

// ---------------------------------------------------------------------------
// export subcommand
// ---------------------------------------------------------------------------

describe("tila record export", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
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
    mockGet
      // CR-1 fix: fetchRecordTypeDef is called FIRST (schema fetch → rejection)
      .mockRejectedValueOnce(new Error("no schema"))
      // List response
      .mockResolvedValueOnce({
        ok: true,
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
        meta: { total: 1, limit: 200, next_cursor: null },
      })
      // Get response
      .mockResolvedValueOnce({
        ok: true,
        record: {
          type: "service",
          key: "api",
          value: { host: "localhost" },
          value_sha256: "abc",
          revision: 1,
          archived: 0,
          created_at: 1700000000000,
          updated_at: 1700000000000,
          updated_by: "cli",
          tags: [],
          schema_version: 1,
        },
        fence: 1,
      });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "export");
    await runCmd(sub, { type: "service", "output-dir": "./out", all: false });

    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(logSpy.mock.calls[0][0]).toContain("Exported service/api");
  });

  it("export with slash key -> nested directory", async () => {
    const fs = await import("node:fs");
    mockGet
      // CR-1 fix: fetchRecordTypeDef schema fetch → rejection comes first
      .mockRejectedValueOnce(new Error("no schema"))
      .mockResolvedValueOnce({
        ok: true,
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
        meta: { total: 1, limit: 200, next_cursor: null },
      })
      .mockResolvedValueOnce({
        ok: true,
        record: {
          type: "service",
          key: "api/staging",
          value: { env: "staging" },
          value_sha256: "abc",
          revision: 1,
          archived: 0,
          created_at: 1700000000000,
          updated_at: 1700000000000,
          updated_by: "cli",
          tags: [],
          schema_version: 1,
        },
        fence: 1,
      });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "export");
    await runCmd(sub, { type: "service", "output-dir": "./out", all: false });

    // Verify mkdirSync was called with nested path containing "api"
    const mkdirCalls = (fs.mkdirSync as ReturnType<typeof vi.fn>).mock.calls;
    const nestedDir = mkdirCalls.find((call: unknown[]) =>
      (call[0] as string).includes("api"),
    );
    expect(nestedDir).toBeDefined();
    // Also verify Exported log includes the key
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("types -> lists all types", async () => {
    mockGet.mockResolvedValue({
      ok: true,
      types: ["pipeline_config", "service"],
      declared_types: ["pipeline_config", "service"],
      in_use_types: ["service"],
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "types");
    await runCmd(sub, { json: false, "in-use": false });

    expect(logSpy).toHaveBeenCalledWith("pipeline_config");
    expect(logSpy).toHaveBeenCalledWith("service");
  });

  it("types --in-use -> only in-use types", async () => {
    mockGet.mockResolvedValue({
      ok: true,
      types: ["pipeline_config", "service"],
      declared_types: ["pipeline_config", "service"],
      in_use_types: ["service"],
    });

    const cmd = await loadCommand();
    const sub = getSubCommand(cmd, "types");
    await runCmd(sub, { json: false, "in-use": true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("service");
  });
});
