/**
 * Local-mode tests for `template` (list/show/instantiate), `search reindex`,
 * and `schema diff` against a REAL `EmbeddedProject` (Task 7).
 *
 * Like `record-local.test.ts`, this suite wires the CLI subcommands onto a real
 * `EmbeddedProject` backed by an in-memory better-sqlite3 DB with the full
 * `@tila/ops-sqlite` migration set applied, with `ctx.client === null` (local
 * mode). It proves the three features work LOCALLY with no HTTP client.
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
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks: schema-loader (so `schema diff` reads a controlled proposed definition)
// and context (hands back a ctx whose backend slots are the real EmbeddedProject).
// ---------------------------------------------------------------------------

const mockLoadComposedSchema = vi.fn();
vi.mock("../../lib/schema-loader", () => ({
  loadComposedSchema: (...args: unknown[]) => mockLoadComposedSchema(...args),
}));

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
// In-memory EmbeddedProject bootstrap (mirrors record-local.test.ts).
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

function makeLocalProject(): EmbeddedProject {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS) {
    runMigration(sqlite, migration);
  }
  const db = drizzle(sqlite, { schema }) as unknown as EmbeddedDb;
  return new EmbeddedProject({
    db,
    org: "testorg",
    project: "test-proj",
    sleepSync: () => {},
    close: () => sqlite.close(),
  });
}

// A schema declaring a `task`/`subtask` work-unit plus a `sprint` template.
const SCHEMA_WITH_TEMPLATE = `
schema_version = 1

[work_units.task]
label = "Task"

[work_units.subtask]
label = "Subtask"

[templates.sprint]
description = "A task with one subtask"

[templates.sprint.entities.root]
type = "task"
id_suffix = ""
[templates.sprint.entities.root.data]
title = "Sprint {{name}}"

[templates.sprint.entities.child]
type = "subtask"
id_suffix = "-child"
[templates.sprint.entities.child.data]
title = "Child of {{name}}"

[[templates.sprint.relationships]]
from = "root"
to = "child"
type = "parent-child"
`;

// ---------------------------------------------------------------------------
// Citty harness
// ---------------------------------------------------------------------------

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

// The command default exports carry their specific arg-literal types; widen to
// the generic `CommandDef` so the shared `runCmd` helper accepts them.
const loadTemplate = async (): Promise<CommandDef> =>
  (await import("../../commands/template")).default as CommandDef;
const loadSearch = async (): Promise<CommandDef> =>
  (await import("../../commands/search")).default as CommandDef;
const loadSchema = async (): Promise<CommandDef> =>
  (await import("../../commands/schema")).default as CommandDef;

// ---------------------------------------------------------------------------

describe("local-mode template / search reindex / schema diff (real EmbeddedProject)", () => {
  let project: EmbeddedProject;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    project = makeLocalProject();
    mockResolveContext.mockReturnValue({
      config: { project_id: "test-proj", backend: "local" },
      client: null,
      machine: "test-machine",
      entity: project,
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
    project.close();
  });

  // --- template list / show / instantiate ---

  it("template list -> reads templates from the applied local schema", async () => {
    await project.applySchema({ definition: SCHEMA_WITH_TEMPLATE });
    const cmd = await loadTemplate();
    await runCmd(getSubCommand(cmd, "list"), { json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.templates).toEqual([
      {
        name: "sprint",
        description: "A task with one subtask",
        entity_count: 2,
      },
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("template show -> renders the template definition from the local schema", async () => {
    await project.applySchema({ definition: SCHEMA_WITH_TEMPLATE });
    const cmd = await loadTemplate();
    await runCmd(getSubCommand(cmd, "show"), { name: "sprint", json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.name).toBe("sprint");
    expect(Object.keys(out.template.entities)).toEqual(["root", "child"]);
  });

  it("template instantiate (apply) -> creates entities + relationships locally", async () => {
    await project.applySchema({ definition: SCHEMA_WITH_TEMPLATE });
    const cmd = await loadTemplate();
    await runCmd(getSubCommand(cmd, "instantiate"), {
      name: "sprint",
      id: "sprint-1",
      var: "name=Alpha",
      json: true,
    });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.created_entities).toEqual(["sprint-1", "sprint-1-child"]);
    expect(out.created_relationships).toBe(1);

    // Entities exist in the local DB with vars substituted.
    const root = await project.get("sprint-1");
    expect(root?.type).toBe("task");
    expect((root?.data as { title: string }).title).toBe("Sprint Alpha");
    const child = await project.get("sprint-1-child");
    expect((child?.data as { title: string }).title).toBe("Child of Alpha");

    // The parent-child relationship was created.
    const rels = await project.listRelationships({ type: "parent-child" });
    expect(rels).toHaveLength(1);
    expect(rels[0].from_id).toBe("sprint-1");
    expect(rels[0].to_id).toBe("sprint-1-child");
  });

  it("template instantiate -> unknown template fails fast with a clean message", async () => {
    await project.applySchema({ definition: SCHEMA_WITH_TEMPLATE });
    const cmd = await loadTemplate();
    await runCmd(getSubCommand(cmd, "instantiate"), {
      name: "missing",
      id: "x-1",
      json: true,
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderr = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(stderr).toMatch(/not found/i);
    // No stack trace leaked.
    expect(stderr).not.toMatch(/at Object\.|node_modules/);
  });

  // --- search reindex ---

  it("search reindex (entity) -> rebuilds FTS so searchAll finds mutated entities", async () => {
    // Create an entity, then directly corrupt/clear its search doc to prove
    // reindex repopulates it. We delete the search doc row out-of-band.
    await project.create({
      id: "task-1",
      type: "task",
      data: { title: "findable widget" },
      created_by: "tester",
    });
    // Sanity: it is searchable after create.
    expect(project.searchAll({ q: "findable" }).length).toBeGreaterThan(0);

    // Clear ALL entity search docs out-of-band (simulating drift).
    project.getDb().run(sql`DELETE FROM entity_search_docs`);
    expect(project.searchAll({ q: "findable" })).toHaveLength(0);

    const cmd = await loadSearch();
    await runCmd(getSubCommand(cmd, "reindex"), { kind: "entity" });

    // After reindex, the entity is findable again.
    expect(project.searchAll({ q: "findable" }).length).toBeGreaterThan(0);
    const out = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(out).toMatch(/Reindex complete for entity/);
  });

  // --- schema diff (real backend) ---

  it("schema diff -> computes added field against the applied local schema", async () => {
    await project.applySchema({
      definition: 'schema_version = 1\n\n[work_units.task]\nlabel = "Task"\n',
    });
    // Proposed schema adds an optional `priority` field.
    mockLoadComposedSchema.mockReturnValue({
      ok: true as const,
      definition:
        'schema_version = 2\n\n[work_units.task]\nlabel = "Task"\n[work_units.task.fields.priority]\ntype = "string"\n',
      schemaVersion: 2,
      warnings: [],
      fragmentCount: 1,
    });

    const cmd = await loadSchema();
    await runCmd(getSubCommand(cmd, "diff"), { json: true });

    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.autoApplicable).toBe(true);
    expect(out.changes).toEqual([
      expect.objectContaining({
        kind: "field-added",
        unitType: "task",
        fieldName: "priority",
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Remote-only commands fail fast (no stack trace) in local mode.
// ---------------------------------------------------------------------------

describe("remote-only commands fail fast in local mode", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveContext.mockReturnValue({
      config: { project_id: "test-proj", backend: "local" },
      client: null,
      machine: "test-machine",
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("token issue -> clean remote-only message, exit 1, no stack trace", async () => {
    const cmd = (await import("../../commands/token")).default;
    await runCmd(getSubCommand(cmd, "issue"), { json: false });
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderr = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(stderr).toMatch(/requires a remote/i);
    expect(stderr).not.toMatch(/at Object\.|node_modules/);
  });
});
