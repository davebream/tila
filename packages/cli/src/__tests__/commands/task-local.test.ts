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

import { readFileSync } from "node:fs";
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
import { generateDefaultSchemaToml } from "../../lib/provisioning";

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
    identity: {
      principal_id: "local:testorg",
      participant_id: "participant-task-test",
      environment: { machine: "test-machine", client_name: "tila-cli" },
    },
    sleepSync: () => {},
    close: () => sqlite.close(),
  });
  const artifacts = new EmbeddedArtifactBackend({
    db,
    blobs: new MemoryBlobStore(),
    org: "testorg",
    project: "test-proj",
    identity: {
      principal_id: "local:testorg",
      participant_id: "participant-task-test",
      environment: { machine: "test-machine", client_name: "tila-cli" },
    },
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

  async function seedTask(id: string, data: Record<string, unknown>) {
    await project.create({ id, type: "task", data, created_by: "cli" });
  }

  it.each([false, true])(
    "lists blocked and outcome pages with exact metadata (compact=%s)",
    async (compact) => {
      await project.applySchema({
        definition: `schema_version = 1
[work_units.task.fields.status]
type = "string"
[work_units.task.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done", "failed"]
dependency_satisfied = ["done"]
[work_units.task.lifecycle.outcomes]
failure = "failed"
`,
        expected_revision: 0,
      });
      await seedTask("gate", { status: "open" });
      for (const id of ["A", "B", "C"]) {
        await seedTask(id, { status: "open", title: id });
        await project.addRelationship({
          from_id: "gate",
          to_id: id,
          type: "blocks",
        });
        await seedTask(`failed-${id}`, { status: "failed" });
      }
      const command = getSubCommand(await loadCommand(), "list");
      await runCmd(command, { blocked: true, limit: "2", compact, json: true });
      const first = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
      expect(first.meta.total).toBe(3);
      expect(first.meta.count).toBe(2);
      expect(first.result.has_more).toBe(true);
      expect(first.meta.next_cursor).toBeTypeOf("string");
      await runCmd(command, {
        blocked: true,
        limit: "2",
        cursor: first.meta.next_cursor,
        compact,
        json: true,
      });
      const last = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
      expect(last.meta.total).toBe(3);
      expect(last.meta.count).toBe(1);
      expect(last.meta.next_cursor).toBeNull();
      await runCmd(command, {
        outcome: "failure,abandoned",
        limit: "1",
        compact,
        json: true,
      });
      const outcome = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
      expect(outcome.meta.total).toBe(3);
      expect(outcome.result.scope.outcome_types).toEqual(["task"]);
      await runCmd(command, { outcome: "success", compact, json: true });
      const empty = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
      expect(empty.meta.total).toBe(0);
      expect(empty.result.scope.outcome_types).toEqual([]);
    },
  );

  it("rejects an invalid outcome before opening the backend", async () => {
    const command = getSubCommand(await loadCommand(), "list");
    mockResolveContext.mockClear();
    await runCmd(command, { outcome: "failed", json: true });
    expect(mockResolveContext).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string)).toMatchObject({
      ok: false,
      error: { kind: "validation-error" },
    });
  });

  it("list --compact projects id/status/title/claimed_by from the local backend", async () => {
    await seedTask("T-1", { status: "open", title: "First" });
    // Claim T-1 so claimed_by is populated.
    await project.acquire("task:T-1", "exclusive", 60000);

    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "list"), { compact: true, json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.meta.count).toBe(1);
    const e = out.result.items[0];
    // Same columns/fields as the old remote ?compact=true payload.
    expect(e).toMatchObject({
      id: "T-1",
      type: "task",
      title: "First",
      status: "open",
      claimed_by: "participant-task-test",
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("list --parent filters to children (both compact and non-compact) in local mode", async () => {
    await seedTask("P", { status: "open", title: "Parent" });
    await seedTask("C1", { status: "open", title: "Child 1", parent_id: "P" });
    await seedTask("C2", { status: "open", title: "Child 2", parent_id: "P" });
    await seedTask("U", { status: "open", title: "Unrelated" });

    const cmd = await loadCommand();

    // Non-compact --parent: only the two children.
    await runCmd(getSubCommand(cmd, "list"), { parent: "P", json: true });
    const nonCompact = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(
      nonCompact.result.items.map((e: { id: string }) => e.id).sort(),
    ).toEqual(["C1", "C2"]);

    // Compact --parent: same two children.
    logSpy.mockClear();
    await runCmd(getSubCommand(cmd, "list"), {
      compact: true,
      parent: "P",
      json: true,
    });
    const compact = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(
      compact.result.items.map((e: { id: string }) => e.id).sort(),
    ).toEqual(["C1", "C2"]);
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
    const ids = out.result.items.map((e: { id: string }) => e.id).sort();
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
    expect(out.result.count).toBe(2);
    expect(
      out.result.relationships.some(
        (r: { from_id: string; to_id: string; type: string }) =>
          r.from_id === "root" &&
          r.to_id === "child" &&
          r.type === "parent-child",
      ),
    ).toBe(true);
  });

  it("tree (non-JSON) renders the multi-level nesting via buildSubtree/renderTree", async () => {
    // grandparent -> parent -> child
    await seedTask("gp", { status: "open", title: "Grandparent" });
    await seedTask("par", { status: "open", title: "Parent" });
    await seedTask("ch", { status: "open", title: "Child" });
    await project.addRelationship({
      from_id: "gp",
      to_id: "par",
      type: "parent-child",
    });
    await project.addRelationship({
      from_id: "par",
      to_id: "ch",
      type: "parent-child",
    });

    const cmd = await loadCommand();
    await runCmd(getSubCommand(cmd, "tree"), { json: false });

    // Single console.log call carrying the treeified string (object-treeify).
    const rendered = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    // All three labels present, and the nesting is exercised (tree branch glyphs).
    expect(rendered).toContain("gp open Grandparent");
    expect(rendered).toContain("par open Parent");
    expect(rendered).toContain("ch open Child");
    expect(rendered).toMatch(/[└├]─/); // object-treeify branch characters
    // Child is indented deeper than parent (multi-level nesting, not flat).
    const idx = (s: string) =>
      rendered.split("\n").findIndex((line: string) => line.includes(s));
    const parentIndent = rendered
      .split("\n")
      [idx("par open Parent")].search(/\S/);
    const childIndent = rendered.split("\n")[idx("ch open Child")].search(/\S/);
    expect(childIndent).toBeGreaterThan(parentIndent);
  });

  it("tree (non-JSON) terminates on a relationship cycle (cycle guard)", async () => {
    // root -> A -> B -> A (cycle). The shared `seen` set must stop recursion.
    await seedTask("rt", { status: "open", title: "Root" });
    await seedTask("A", { status: "open", title: "A" });
    await seedTask("B", { status: "open", title: "B" });
    await project.addRelationship({
      from_id: "rt",
      to_id: "A",
      type: "parent-child",
    });
    await project.addRelationship({
      from_id: "A",
      to_id: "B",
      type: "parent-child",
    });
    await project.addRelationship({
      from_id: "B",
      to_id: "A",
      type: "parent-child",
    });

    const cmd = await loadCommand();
    // Must COMPLETE (no infinite recursion / RangeError) — the assertion is
    // that the promise resolves and renders without throwing.
    await expect(
      runCmd(getSubCommand(cmd, "tree"), { json: false }),
    ).resolves.toBeUndefined();
    const rendered = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    // The reachable nodes were rendered (each label appears at least once).
    expect(rendered).toContain("rt open Root");
    expect(rendered).toContain("A open A");
    expect(rendered).toContain("B open B");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("update --fence rejects a stale fence with a clean one-line error (no stack trace)", async () => {
    await seedTask("T-fence", { status: "open", title: "Fenced" });
    const acq = await project.acquire("task:T-fence", "exclusive", 60000);

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

    // Stale fence: the command resolves (does NOT throw a raw error up to the
    // citty top-level handler, which would dump the bundled stack trace).
    // Instead it prints a clean one-line message to stderr and exits 1.
    logSpy.mockClear();
    errorSpy.mockClear();
    await expect(
      runCmd(getSubCommand(cmd, "update"), {
        id: "T-fence",
        field: "status=done",
        fence: String(acq.fence - 1),
        json: false,
      }),
    ).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toMatch(/fence/i); // mentions the cause
    expect(msg).not.toContain("\n"); // single line
    expect(msg).not.toMatch(/\s+at\s+\S+:\d+/); // no stack frames leaked
    // Success line never printed on the rejected path.
    expect(logSpy).not.toHaveBeenCalled();
    // Value unchanged after the rejected update.
    expect((await project.get("T-fence"))?.data.status).toBe("in-progress");
  });

  it("update --fence (JSON mode) emits a structured stale-fence error, not a stack trace", async () => {
    await seedTask("T-fence-json", { status: "open", title: "Fenced" });
    const acq = await project.acquire("task:T-fence-json", "exclusive", 60000);

    const cmd = await loadCommand();
    await expect(
      runCmd(getSubCommand(cmd, "update"), {
        id: "T-fence-json",
        field: "status=done",
        fence: String(acq.fence - 1),
        json: true,
      }),
    ).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(payload.error.kind).toBe("stale-fence");
    expect(typeof payload.error.message).toBe("string");
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
    expect(out.result.references).toHaveLength(1);
    expect(out.result.references[0]).toMatchObject({
      entity_id: "T-ref",
      artifact_key: "plans/T-ref/abc.md",
      slot: "plan",
    });
  });

  describe("close", () => {
    const BUNDLED_SCHEMA = readFileSync(
      new URL("../../../../../tila.schema.toml", import.meta.url),
      "utf8",
    );
    const apply = (definition: string) =>
      project.applySchema({ definition, expected_revision: 0 });
    const lastJson = (spy: ReturnType<typeof vi.spyOn>) =>
      JSON.parse(spy.mock.calls.at(-1)?.[0] as string);

    async function expectRefused(
      id: string,
      outcome: string,
      kind: string,
      message: RegExp,
    ) {
      const before = (await project.get(id))?.data;
      await runCmd(getSubCommand(await loadCommand(), "close"), {
        id,
        outcome,
        json: true,
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
      const envelope = lastJson(errorSpy);
      expect(envelope).toMatchObject({ ok: false, error: { kind } });
      expect(envelope.error.message).toMatch(message);
      // Refused before any write: the entity is exactly as seeded.
      expect((await project.get(id))?.data).toEqual(before);
      return envelope;
    }

    it.each([
      ["generated", () => generateDefaultSchemaToml()],
      ["bundled", () => BUNDLED_SCHEMA],
    ])(
      "%s schema maps each outcome to its declared terminal state",
      async (_name, definition) => {
        await apply(definition());
        const close = getSubCommand(await loadCommand(), "close");
        const cases: [string, string, string][] = [
          ["completed", "success", "done"],
          ["success", "success", "done"],
          ["failure", "failure", "failed"],
          ["cancelled", "cancelled", "cancelled"],
          ["deferred", "abandoned", "deferred"],
          ["abandoned", "abandoned", "deferred"],
        ];
        for (const [outcome, canonical, status] of cases) {
          const id = `T-${outcome}`;
          await seedTask(id, { status: "in_progress", title: outcome });
          await runCmd(close, { id, outcome, json: true });
          // Only the lifecycle field changes; no `outcome` field is stored.
          expect((await project.get(id))?.data).toEqual({
            status,
            title: outcome,
          });
          expect(lastJson(logSpy).result).toMatchObject({
            id,
            outcome,
            lifecycle_outcome: canonical,
            field: "status",
            state: status,
          });
        }
        expect(errorSpy).not.toHaveBeenCalled();
      },
    );

    it("reports the written state in text mode", async () => {
      await apply(generateDefaultSchemaToml());
      await seedTask("T-text", { status: "open", title: "Text" });
      await runCmd(getSubCommand(await loadCommand(), "close"), {
        id: "T-text",
        outcome: "completed",
      });
      expect(logSpy.mock.calls.at(-1)?.[0]).toBe(
        "Closed task T-text with outcome: completed; status set to done",
      );
    });

    it("honors a custom type, lifecycle field and outcome mapping", async () => {
      await apply(`schema_version = 1

[work_units.ticket]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "phase", required = true, type = "enum", values = ["todo", "doing", "shipped", "dropped"] },
]
parents = []

[work_units.ticket.lifecycle]
field = "phase"
dispatchable = ["todo"]
terminal = ["shipped", "dropped"]
dependency_satisfied = ["shipped"]
on_start = "doing"

[work_units.ticket.lifecycle.outcomes]
success = "shipped"
cancelled = "dropped"
`);
      await project.create({
        id: "K-1",
        type: "ticket",
        data: { title: "Ship it", phase: "doing" },
        created_by: "cli",
      });
      await runCmd(getSubCommand(await loadCommand(), "close"), {
        id: "K-1",
        outcome: "completed",
        json: true,
      });
      expect((await project.get("K-1"))?.data).toEqual({
        title: "Ship it",
        phase: "shipped",
      });
      expect(lastJson(logSpy).result).toMatchObject({
        field: "phase",
        state: "shipped",
      });
    });

    it("refuses when no schema is applied", async () => {
      await seedTask("T-none", { status: "open", title: "None" });
      await expectRefused(
        "T-none",
        "completed",
        "constraint-violation",
        /No schema is applied/,
      );
    });

    it("refuses a schema that declares no lifecycle, with apply guidance", async () => {
      // The shape `tila project create` generated before lifecycle outcomes.
      await apply(`schema_version = 1

[work_units.task]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "status", required = true, type = "enum", values = ["open", "in_progress", "blocked", "done", "cancelled"] },
]
parents = []
`);
      await seedTask("T-legacy", { status: "open", title: "Legacy" });
      const envelope = await expectRefused(
        "T-legacy",
        "completed",
        "constraint-violation",
        /declares no lifecycle/,
      );
      expect(envelope.error.hint).toMatch(/tila schema apply/);
    });

    it("refuses an outcome the lifecycle does not map and still closes mapped ones", async () => {
      // Bundled sample as it was before #522: only success and cancelled.
      await apply(`schema_version = 1

[work_units.task]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "status", required = true, type = "enum", values = ["open", "in_progress", "blocked", "done", "cancelled"] },
]
parents = []

[work_units.task.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done", "cancelled"]
dependency_satisfied = ["done"]
on_start = "in_progress"

[work_units.task.lifecycle.outcomes]
success = "done"
cancelled = "cancelled"
`);
      await seedTask("T-fail", { status: "open", title: "Fail" });
      await expectRefused(
        "T-fail",
        "failure",
        "constraint-violation",
        /does not map outcome "failure"/,
      );
      await expectRefused(
        "T-fail",
        "deferred",
        "constraint-violation",
        /does not map outcome "abandoned"/,
      );
      await runCmd(getSubCommand(await loadCommand(), "close"), {
        id: "T-fail",
        outcome: "completed",
        json: true,
      });
      expect((await project.get("T-fail"))?.data.status).toBe("done");
    });

    it("refuses an outcome mapped to a non-terminal state", async () => {
      await apply(`schema_version = 1

[work_units.task]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "status", required = true, type = "enum", values = ["open", "review", "done"] },
]
parents = []

[work_units.task.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]

[work_units.task.lifecycle.outcomes]
success = "review"
`);
      await seedTask("T-review", { status: "open", title: "Review" });
      await expectRefused(
        "T-review",
        "success",
        "constraint-violation",
        /"review", which is not a terminal state/,
      );
    });

    it.each(["closed", "failed", "done", ""])(
      "rejects outcome %j before opening the backend",
      async (outcome) => {
        mockResolveContext.mockClear();
        await runCmd(getSubCommand(await loadCommand(), "close"), {
          id: "T-1",
          outcome,
          json: true,
        });
        expect(mockResolveContext).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(lastJson(errorSpy)).toMatchObject({
          ok: false,
          error: { kind: "validation-error" },
        });
      },
    );

    it("reports an unknown task before reading the schema", async () => {
      await apply(generateDefaultSchemaToml());
      await runCmd(getSubCommand(await loadCommand(), "close"), {
        id: "missing",
        outcome: "completed",
        json: true,
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(lastJson(errorSpy)).toMatchObject({
        ok: false,
        error: { kind: "not-found" },
      });
    });
  });
});
