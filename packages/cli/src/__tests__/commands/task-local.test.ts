/**
 * Local-mode task command tests.
 *
 * Like `record-local.test.ts`, this suite wires the task subcommands onto a
 * REAL `EmbeddedProject` backed by an in-memory better-sqlite3 DB (full
 * `@tila/ops-sqlite` migration set applied). It proves the five remote-only
 * task paths now work in local mode with NO HTTP client (`ctx.client === null`):
 *   - `task list --compact`
 *   - `task ready`
 *   - `task tree`
 *   - `task update --fence`
 *   - `task artifact-ref add` / `list`
 */

import {
  type BlobStore,
  EmbeddedArtifactBackend,
  type EmbeddedDb,
  EmbeddedProject,
} from "@tila/backend-embedded";
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

// Spinner is a no-op so withSpinner resolves synchronously.
vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

// Context is mocked to hand back a ctx whose `entity`/`coordination` slots are
// the real EmbeddedProject and `client` is null (local mode).
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
// In-memory EmbeddedProject + artifact backend bootstrap.
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

/** Minimal in-memory BlobStore so the artifact backend can write pointers. */
class MemoryBlobStore implements BlobStore {
  private store = new Map<string, Uint8Array>();
  async write(key: string, data: Uint8Array | string) {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.store.set(key, bytes);
    return { bytes: bytes.byteLength };
  }
  async readStream(key: string) {
    const bytes = this.store.get(key);
    if (bytes === undefined) return null;
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }
  async read(key: string) {
    const bytes = this.store.get(key);
    return bytes === undefined ? null : new TextDecoder().decode(bytes);
  }
  async list(prefix: string) {
    const out: { key: string; size: number }[] = [];
    for (const [key, bytes] of this.store) {
      if (key.startsWith(prefix)) out.push({ key, size: bytes.byteLength });
    }
    return out;
  }
  async exists(key: string) {
    return this.store.has(key);
  }
  async unlink(key: string) {
    this.store.delete(key);
  }
}

function makeLocalProject(): {
  project: EmbeddedProject;
  artifacts: EmbeddedArtifactBackend;
  close: () => void;
} {
  const sqlite = new Database(":memory:");
  // foreign_keys ON so the artifact-ref FK to artifact_pointers is enforced.
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS) {
    runMigration(sqlite, migration);
  }
  const db = drizzle(sqlite, { schema }) as unknown as EmbeddedDb;
  const project = new EmbeddedProject({
    db,
    org: "testorg",
    project: "test-proj",
    sleepSync: () => {},
    close: () => sqlite.close(),
  });
  const artifacts = new EmbeddedArtifactBackend({
    db,
    blobs: new MemoryBlobStore(),
    org: "testorg",
    project: "test-proj",
    sleepSync: () => {},
  });
  return { project, artifacts, close: () => sqlite.close() };
}

// ---------------------------------------------------------------------------
// Citty command harness.
// ---------------------------------------------------------------------------

const loadCommand = async () => {
  const mod = await import("../../commands/task");
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

describe("task commands (local mode, real EmbeddedProject)", () => {
  let project: EmbeddedProject;
  let artifacts: EmbeddedArtifactBackend;
  let close: () => void;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ project, artifacts, close } = makeLocalProject());
    mockResolveContext.mockReturnValue({
      config: { project_id: "test-proj" },
      client: null,
      machine: "test-machine",
      entity: project,
      coordination: project,
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

  async function seedTask(id: string, data: Record<string, unknown>) {
    await project.create({ id, type: "task", data, created_by: "cli" });
  }

  it("list --compact projects id/status/title/claimed_by from the local backend", async () => {
    await seedTask("T-1", { status: "open", title: "First" });
    // Claim T-1 so claimed_by is populated.
    await project.acquire("task:T-1", "m1", "u1", "exclusive", 60000);

    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "list"), { compact: true, json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.count).toBe(1);
    const e = out.entities[0];
    // Same columns/fields as the old remote ?compact=true payload.
    expect(e).toMatchObject({
      id: "T-1",
      type: "task",
      title: "First",
      status: "open",
      claimed_by: "m1/u1",
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ready returns unblocked tasks from the local backend", async () => {
    await seedTask("blocker", { status: "open", title: "Blocker" });
    await seedTask("blocked", { status: "open", title: "Blocked" });
    await seedTask("free", { status: "open", title: "Free" });
    await project.addRelationship({
      from_id: "blocker",
      to_id: "blocked",
      type: "blocks",
    });

    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "ready"), { json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    const ids = out.entities.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(["blocker", "free"]);
  });

  it("tree renders the parent-child relationship tree", async () => {
    await seedTask("root", { status: "open", title: "Root" });
    await seedTask("child", { status: "open", title: "Child" });
    await project.addRelationship({
      from_id: "root",
      to_id: "child",
      type: "parent-child",
    });

    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "tree"), { json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.count).toBe(2);
    expect(
      out.relationships.some(
        (r: { from_id: string; to_id: string; type: string }) =>
          r.from_id === "root" &&
          r.to_id === "child" &&
          r.type === "parent-child",
      ),
    ).toBe(true);
  });

  it("update --fence enforces the fence (stale fence is rejected)", async () => {
    await seedTask("T-fence", { status: "open", title: "Fenced" });
    const acq = await project.acquire(
      "task:T-fence",
      "local",
      "local",
      "exclusive",
      60000,
    );

    const cmd = await loadCommand();

    // Valid fence updates.
    await runCmd(getSubCommand(cmd, "update"), {
      id: "T-fence",
      field: "status=in-progress",
      fence: String(acq.fence),
      json: true,
    });
    expect((await project.get("T-fence"))?.data.status).toBe("in-progress");
    expect(errorSpy).not.toHaveBeenCalled();

    // Stale fence throws.
    await expect(
      runCmd(getSubCommand(cmd, "update"), {
        id: "T-fence",
        field: "status=done",
        fence: String(acq.fence - 1),
        json: true,
      }),
    ).rejects.toThrow();
    // Value unchanged after the rejected update.
    expect((await project.get("T-fence"))?.data.status).toBe("in-progress");
  });

  it("artifact-ref add -> list round-trips against the local backend", async () => {
    await seedTask("T-ref", { status: "open", title: "Has refs" });
    // The artifact_key FK references artifact_pointers(r2_key).
    await artifacts.put({
      key: "plans/T-ref/abc.md",
      body: "plan",
      sha256: "deadbeef",
      metadata: {},
      contentType: "text/markdown",
    });

    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "artifact-ref", "add"), {
      entityId: "T-ref",
      artifactKey: "plans/T-ref/abc.md",
      slot: "plan",
      json: true,
    });
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockClear();
    await runCmd(getSubCommand(cmd, "artifact-ref", "list"), {
      entityId: "T-ref",
      json: true,
    });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.references).toHaveLength(1);
    expect(out.references[0]).toMatchObject({
      entity_id: "T-ref",
      artifact_key: "plans/T-ref/abc.md",
      slot: "plan",
    });
  });
});
