/**
 * Local-mode record command tests.
 *
 * Unlike `record.test.ts` (which mocks the backend), this suite wires the
 * record subcommands onto a REAL `EmbeddedProject` backed by an in-memory
 * better-sqlite3 database with the full `@tila/ops-sqlite` migration set
 * applied. It proves `record set`/`get`/`patch`/`list`/`history` round-trip
 * through the local backend with NO HTTP client (`ctx.client === null`),
 * exactly as `tila` runs against a `backend = "local"` project.
 */

import { type EmbeddedDb, EmbeddedProject } from "@tila/backend-embedded";
import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
  schema,
} from "@tila/ops-sqlite";
import Database from "better-sqlite3";
import type { CommandDef, SubCommandsDef } from "citty";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// node:fs is mocked so `record set` reads its value file from an in-memory map
// rather than the real filesystem.
// ---------------------------------------------------------------------------
const fileContents = new Map<string, string>();
vi.mock("node:fs", () => ({
  readFileSync: vi.fn((path: string) => {
    const content = fileContents.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Spinner is a no-op so withSpinner resolves synchronously.
vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

// The context module is mocked to hand back a ctx whose `record`/`schema`
// slots are the real EmbeddedProject and `client` is null (local mode).
const mockResolveContext = vi.fn();
vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => {
    if (!ctx.client) {
      throw new Error(
        "This command requires a remote backend (not local mode).",
      );
    }
    return ctx.client;
  },
  resolveContext: () => mockResolveContext(),
}));

// ---------------------------------------------------------------------------
// In-memory EmbeddedProject bootstrap (mirrors backend-do test create-test-db).
// ---------------------------------------------------------------------------

function createMigrationStorage(
  sqlite: InstanceType<typeof Database>,
): MigrationStorage {
  return {
    sql: {
      exec<T>(statement: string, ...bindings: unknown[]) {
        if (/^\s*(SELECT|PRAGMA)\b/i.test(statement)) {
          return {
            toArray: () => sqlite.prepare(statement).all(...bindings) as T[],
          };
        }
        if (bindings.length > 0) {
          sqlite.prepare(statement).run(...bindings);
        } else {
          sqlite.exec(statement);
        }
        return { toArray: () => [] as T[] };
      },
    },
  };
}

function runMigration(
  sqlite: InstanceType<typeof Database>,
  migration: Migration,
) {
  if ("run" in migration) {
    migration.run(createMigrationStorage(sqlite));
    return;
  }
  sqlite.exec(migration.sql);
}

function makeLocalProject(): { project: EmbeddedProject; close: () => void } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS) {
    runMigration(sqlite, migration);
  }
  // The drizzle better-sqlite3 handle carries a `RunResult` result type;
  // EmbeddedDb is the neutral `"sync", void` handle. The runtime shape is
  // identical, so narrow it to EmbeddedDb for the embedded constructor.
  const db = drizzle(sqlite, { schema }) as unknown as EmbeddedDb;
  const project = new EmbeddedProject({
    db,
    org: "testorg",
    project: "test-proj",
    // better-sqlite3 is synchronous; a no-op blocking sleep is fine for tests.
    sleepSync: () => {},
    close: () => sqlite.close(),
  });
  return { project, close: () => sqlite.close() };
}

// ---------------------------------------------------------------------------
// Citty command harness (same shape as record.test.ts).
// ---------------------------------------------------------------------------

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
  await (cmd.run as RunFn)({ rawArgs: [], args: { _: [], ...args }, cmd });
}

// ---------------------------------------------------------------------------

describe("record commands (local mode, real EmbeddedProject)", () => {
  let project: EmbeddedProject;
  let close: () => void;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    fileContents.clear();
    ({ project, close } = makeLocalProject());
    // Local-mode ctx: client is null, record/schema are the real backend.
    mockResolveContext.mockReturnValue({
      config: { project_id: "test-proj" },
      client: null,
      machine: "test-machine",
      record: project,
      schema: project,
    });
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
    close();
  });

  it("set (create) -> get round-trips against the local backend", async () => {
    fileContents.set("/tmp/value.json", JSON.stringify({ host: "localhost" }));
    const cmd = await loadCommand();

    await runCmd(getSubCommand(cmd, "set"), {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      json: false,
    });
    expect(
      logSpy.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("Set record service/api"),
      ),
    ).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();

    // The record now exists in the local DB.
    const stored = await project.getRecord("service", "api");
    expect(stored?.value).toEqual({ host: "localhost" });

    logSpy.mockClear();
    await runCmd(getSubCommand(cmd, "get"), {
      type: "service",
      key: "api",
      json: false,
    });
    const out = logSpy.mock.calls[0][0] as string;
    expect(JSON.parse(out)).toEqual({ host: "localhost" });
  });

  it("set with --fence updates, then patch merges -- all via the local backend", async () => {
    fileContents.set("/tmp/value.json", JSON.stringify({ host: "localhost" }));
    const cmd = await loadCommand();

    // Create
    await runCmd(getSubCommand(cmd, "set"), {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      json: false,
    });
    const created = await project.getRecord("service", "api");
    expect(created).not.toBeNull();
    const fence = created?.fence as number;

    // Update with fence
    fileContents.set("/tmp/value.json", JSON.stringify({ host: "remotehost" }));
    await runCmd(getSubCommand(cmd, "set"), {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      fence: String(fence),
      json: false,
    });
    const updated = await project.getRecord("service", "api");
    expect(updated?.value).toEqual({ host: "remotehost" });
    expect(updated?.revision).toBe(2);

    // Patch (merge) with the new fence
    await runCmd(getSubCommand(cmd, "patch"), {
      type: "service",
      key: "api",
      json: '{"port":8080}',
      fence: String(updated?.fence),
    });
    const patched = await project.getRecord("service", "api");
    expect(patched?.value).toEqual({ host: "remotehost", port: 8080 });
  });

  it("list -> shows records of a type from the local backend", async () => {
    fileContents.set("/tmp/value.json", JSON.stringify({ host: "localhost" }));
    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "set"), {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      json: false,
    });

    logSpy.mockClear();
    await runCmd(getSubCommand(cmd, "list"), { type: "service", json: true });
    const envelope = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(envelope.ok).toBe(true);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0].key).toBe("api");
  });

  it("history -> returns revisions from the local backend", async () => {
    fileContents.set("/tmp/value.json", JSON.stringify({ n: 1 }));
    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "set"), {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      json: false,
    });
    const created = await project.getRecord("service", "api");
    fileContents.set("/tmp/value.json", JSON.stringify({ n: 2 }));
    await runCmd(getSubCommand(cmd, "set"), {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      fence: String(created?.fence),
      json: false,
    });

    logSpy.mockClear();
    await runCmd(getSubCommand(cmd, "history"), {
      type: "service",
      key: "api",
      json: true,
    });
    const envelope = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(envelope.ok).toBe(true);
    // Two revisions: created + set.
    expect(envelope.items.length).toBeGreaterThanOrEqual(2);
  });

  it("set of a SNAPSHOT-history type fails in local mode with a clear message", async () => {
    // Apply a schema that declares a snapshot-history record type.
    await project.applySchema({
      definition:
        'schema_version = 1\n[records.pipeline_config]\nhistory = "snapshot"\n',
    });
    fileContents.set("/tmp/value.json", JSON.stringify({ data: 1 }));
    const cmd = await loadCommand();

    await runCmd(getSubCommand(cmd, "set"), {
      type: "pipeline_config",
      key: "main",
      file: "/tmp/value.json",
      json: false,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(msg).toMatch(/snapshot/i);
    expect(msg).toMatch(/remote backend/i);
    // No record should have been written.
    expect(await project.getRecord("pipeline_config", "main")).toBeNull();
  });

  // Regression (cross-backend parity): against a REAL local backend, the
  // default `record types` listing must MERGE a schema-declared-but-unused type,
  // while `--in-use` must EXCLUDE it (only types with active records).
  it("types: default merges declared-but-unused type; --in-use excludes it", async () => {
    await project.applySchema({
      definition: `
schema_version = 1

[records.declared_only.fields.value]
type = "string"

[records.service.fields.value]
type = "string"
`,
    });
    // Create a record only for `service` -> `declared_only` is declared but unused.
    fileContents.set("/tmp/value.json", JSON.stringify({ value: "1" }));
    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "set"), {
      type: "service",
      key: "api",
      file: "/tmp/value.json",
      json: false,
    });

    // Sanity: the backend's in-use-only method excludes the unused declared type.
    expect(await project.listRecordTypesInUse()).toEqual(["service"]);

    // Default (merged): declared_only IS present.
    logSpy.mockClear();
    await runCmd(getSubCommand(cmd, "types"), { json: true, "in-use": false });
    const merged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(merged.types).toEqual(["declared_only", "service"]);

    // --in-use: declared_only is EXCLUDED.
    logSpy.mockClear();
    await runCmd(getSubCommand(cmd, "types"), { json: true, "in-use": true });
    const inUse = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(inUse.types).toEqual(["service"]);
  });
});
