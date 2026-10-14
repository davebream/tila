/**
 * `tila schema import`, `export` and `status` against a REAL `EmbeddedProject`
 * (local mode). Import previews unless given --expected-revision, merges by
 * default, gates replace removals and destructive changes, and conflicts on a
 * stale revision. Export writes metadata and round-trips through import.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EmbeddedDb, EmbeddedProject } from "@tila/backend-embedded";
import { getIn, parseDefinitionDocument, parseSchemaToml } from "@tila/core";
import {
  MIGRATIONS,
  MIGRATION_BOOTSTRAP,
  type Migration,
  type MigrationStorage,
  schema,
} from "@tila/ops-sqlite";
import { canonicalJson } from "@tila/schemas";
import Database from "better-sqlite3";
import type { CommandDef, SubCommandsDef } from "citty";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { RemoteBackend } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliClient } from "../../lib/client-factory";
import { withOutput } from "../../lib/output";

const mockLoadComposedSchema = vi.fn();
vi.mock("../../lib/schema-loader", () => ({
  loadComposedSchema: (...args: unknown[]) => mockLoadComposedSchema(...args),
}));

const mockResolveContext = vi.fn();
vi.mock("../../context", () => ({
  resolveContext: () => mockResolveContext(),
}));

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
        if (bindings.length > 0) sqlite.prepare(statement).run(...bindings);
        else sqlite.exec(statement);
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
  for (const migration of MIGRATIONS) runMigration(sqlite, migration);
  const db = drizzle(sqlite, { schema }) as unknown as EmbeddedDb;
  return new EmbeddedProject({
    db,
    org: "testorg",
    project: "test-proj",
    sleepSync: () => {},
    close: () => sqlite.close(),
  });
}

const BOOTSTRAP = `schema_version = 1

[work_units.task]
parents = []
fields = [
  { name = "title", type = "string", required = true },
  { name = "status", type = "enum", values = ["open", "done"] },
]

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30

[templates.solo]
description = "One task"
[templates.solo.entities.root]
id_suffix = "root"
type = "task"
`;

const BOOTSTRAP_YAML = `schema_version: 1
work_units:
  task:
    parents: []
    fields:
      - { name: title, type: string, required: true }
      - { name: status, type: enum, values: [open, done] }
artifacts:
  plan:
    mime_types: [text/markdown]
    retention_days: 30
templates:
  solo:
    description: One task
    entities:
      root:
        id_suffix: root
        type: task
`;

function getSubCommand(cmd: CommandDef, ...path: string[]): CommandDef {
  let current = cmd;
  for (const name of path) {
    const subs = current.subCommands as SubCommandsDef;
    const sub = subs[name];
    if (!sub || typeof sub === "function" || sub instanceof Promise)
      throw new Error(`subCommand "${name}" not found`);
    current = sub;
  }
  return current;
}

async function run(name: string, args: Record<string, unknown>) {
  const cmd = (await import("../../commands/schema")).default as CommandDef;
  const sub = getSubCommand(cmd, name);
  type RunFn = (ctx: {
    rawArgs: string[];
    args: Record<string, unknown> & { _: string[] };
    cmd: CommandDef;
  }) => void | Promise<void>;
  await (sub.run as RunFn)({ rawArgs: [], args: { _: [], ...args }, cmd: sub });
}

describe("schema import / export / status (local EmbeddedProject)", () => {
  let project: EmbeddedProject;
  let dir: string;
  let logs: string[];
  let warnings: string[];
  let stdout: string[];

  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text, "utf8");
    return path;
  };
  const revision = async () => (await project.getCurrentSchema()).revision ?? 0;
  const applied = async () =>
    (await project.getCurrentSchema()).definition ?? "";
  const json = () =>
    JSON.parse(logs.find((line) => line.startsWith("{")) ?? "null");
  const useProject = (next: EmbeddedProject) => {
    mockResolveContext.mockReturnValue({
      config: { project_id: "test-proj", backend: "local" },
      client: null,
      schema: next,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    project = makeLocalProject();
    useProject(project);
    dir = mkdtempSync(join(tmpdir(), "tila-schema-transfer-"));
    logs = [];
    warnings = [];
    stdout = [];
    vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...a) => {
      warnings.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string,
      callback?: () => void,
    ) => {
      stdout.push(String(value));
      callback?.();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    await run("import", {
      file: file("tila.schema.toml", BOOTSTRAP),
      "expected-revision": "0",
    });
    expect(await revision()).toBe(1);
  }

  it.each([false, true])(
    "shows one revisionless apply diagnostic on stderr (json=%s) with real local storage",
    async (jsonMode) => {
      mockLoadComposedSchema.mockReturnValue({
        ok: true,
        definition: BOOTSTRAP,
        warnings: [],
      });
      await withOutput(
        { json: jsonMode, nonInteractive: true, mutating: true },
        () =>
          run("apply", { json: jsonMode, "idempotency-key": "legacy-apply" }),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("schema-revision-deprecated");
      expect(warnings[0]).toContain("expected_revision");
      if (jsonMode) {
        expect(JSON.parse(warnings[0])).toMatchObject({
          type: "diagnostic",
          level: "warning",
        });
        const value = JSON.parse(stdout.join(""));
        expect(value.result).toMatchObject({
          revision: 1,
          warnings: [
            {
              code: "schema-revision-deprecated",
              observed_revision: 0,
              result_revision: 1,
            },
          ],
        });
      } else {
        expect(logs.join("\n")).toContain("Applied schema version 1");
      }
      expect(await revision()).toBe(1);
      warnings.length = 0;
      await run("apply", { "idempotency-key": "legacy-apply" });
      expect(warnings).toHaveLength(1);
      expect(await revision()).toBe(1);
      expect(
        await project.listJournal({ kind: "schema.revisionless_applied" }),
      ).toHaveLength(1);
      warnings.length = 0;
      await run("apply", {});
      expect(warnings).toHaveLength(1);
      expect(
        await project.listJournal({ kind: "schema.revisionless_applied" }),
      ).toHaveLength(1);
    },
  );

  it("does not emit a deprecation warning on conditional success, stale revision or rejected apply", async () => {
    mockLoadComposedSchema.mockReturnValue({
      ok: true,
      definition: BOOTSTRAP,
      warnings: [],
    });
    await run("apply", { "expected-revision": "0" });
    expect(warnings).toHaveLength(0);
    await expect(
      run("apply", { "expected-revision": "0" }),
    ).rejects.toMatchObject({ code: "schema-revision-conflict" });
    expect(warnings).toHaveLength(0);
    mockLoadComposedSchema.mockReturnValue({
      ok: true,
      definition: "schema_version = [",
      warnings: [],
    });
    await expect(run("apply", {})).rejects.toBeDefined();
    expect(warnings).toHaveLength(0);
  });

  it("renders one JSON stderr warning when the CLI uses the actual SDK remote backend", async () => {
    mockLoadComposedSchema.mockReturnValue({
      ok: true,
      definition: BOOTSTRAP,
      warnings: [],
    });
    // Exercise CLI -> SDK HTTP serialization -> real local apply -> HTTP result.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const result = await project.applySchema(JSON.parse(init.body));
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    mockResolveContext.mockReturnValue({
      config: { project_id: "test-proj" },
      schema: new RemoteBackend(
        createCliClient("https://worker", "token"),
        "test-proj",
      ),
    });
    await withOutput({ json: true, nonInteractive: true, mutating: true }, () =>
      run("apply", { json: true }),
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0])).toMatchObject({
      type: "diagnostic",
      level: "warning",
      message: expect.stringContaining("schema-revision-deprecated"),
    });
    expect(JSON.parse(stdout.join("")).result.warnings).toHaveLength(1);
    expect(
      await project.listJournal({ kind: "schema.revisionless_applied" }),
    ).toHaveLength(1);
  });

  describe("import", () => {
    it("previews by default and applies nothing", async () => {
      const path = file("tila.schema.toml", BOOTSTRAP);
      await run("import", { file: path });
      expect(await revision()).toBe(0);
      const text = logs.join("\n");
      expect(text).toContain("onto revision 0");
      expect(text).toContain("work_units.task");
      expect(text).toContain(
        `Nothing applied. To apply: tila schema import ${path} --expected-revision 0`,
      );
    });

    it("bootstraps at revision 0 and reports JSON", async () => {
      await run("import", {
        file: file("tila.schema.toml", BOOTSTRAP),
        "expected-revision": "0",
        json: true,
      });
      expect(json()).toMatchObject({
        ok: true,
        result: { status: "applied", revision: 1, mode: "merge" },
      });
      expect(canonicalJson(parseSchemaToml(await applied()))).toBe(
        canonicalJson(parseSchemaToml(BOOTSTRAP)),
      );
    });

    it("merge keeps sections the file omits", async () => {
      await bootstrap();
      await run("import", {
        file: file(
          "plan.toml",
          '[artifacts.plan]\nmime_types = ["text/markdown"]\nretention_days = 7\n',
        ),
        "expected-revision": "1",
        // Retention edits are destructive: they change when artifacts expire.
        strategy: "relax",
      });
      const doc = parseDefinitionDocument(await applied());
      if (!doc.ok) throw new Error("unreadable");
      expect(getIn(doc.doc, ["artifacts", "plan", "retention_days"])).toBe(7);
      expect(getIn(doc.doc, ["templates", "solo"])).toBeDefined();
      expect(getIn(doc.doc, ["work_units", "task"])).toBeDefined();
    });

    it("replace requires confirmed removals and a destructive strategy", async () => {
      await bootstrap();
      const path = file(
        "only-task.toml",
        `schema_version = 1\n[work_units.task]\nparents = []\nfields = [{ name = "title", type = "string", required = true }]\n`,
      );
      await expect(
        run("import", {
          file: path,
          mode: "replace",
          "expected-revision": "1",
        }),
      ).rejects.toMatchObject({ code: "removals-not-confirmed" });
      await expect(
        run("import", {
          file: path,
          mode: "replace",
          "expected-revision": "1",
          "confirm-removals": true,
        }),
      ).rejects.toMatchObject({ code: "schema-destructive" });
      expect(await revision()).toBe(1);

      await run("import", {
        file: path,
        mode: "replace",
        "expected-revision": "1",
        "confirm-removals": true,
        strategy: "relax",
      });
      expect(await revision()).toBe(2);
      const doc = parseDefinitionDocument(await applied());
      if (!doc.ok) throw new Error("unreadable");
      expect(doc.doc.templates).toBeUndefined();
      expect(doc.doc.artifacts).toBeUndefined();
    });

    it("conflicts when the revision moved after the preview", async () => {
      await bootstrap();
      await project.applySchema({
        definition: `${BOOTSTRAP}\n[work_units.bug]\nparents = []\n`,
        expected_revision: 1,
      });
      await expect(
        run("import", {
          file: file("tila.schema.toml", BOOTSTRAP),
          "expected-revision": "1",
        }),
      ).rejects.toMatchObject({ code: "schema-revision-conflict" });
      expect(await revision()).toBe(2);
    });

    it("imports YAML to the same definition as TOML", async () => {
      await run("import", {
        file: file("defs.yaml", BOOTSTRAP_YAML),
        "expected-revision": "0",
      });
      const fromYaml = await applied();
      const other = makeLocalProject();
      useProject(other);
      await run("import", {
        file: file("defs.toml", BOOTSTRAP),
        "expected-revision": "0",
      });
      expect(fromYaml).toBe((await other.getCurrentSchema()).definition);
    });

    it("reports no change when the file matches", async () => {
      await bootstrap();
      await run("import", {
        file: file("tila.schema.toml", BOOTSTRAP),
        "expected-revision": "1",
      });
      expect(logs.join("\n")).toContain("No changes");
      expect(await revision()).toBe(1);
    });

    it.each([
      ["defs.json", "{}", "unsupported-format"],
      [
        "secret.toml",
        'schema_version = 1\n[extra]\napi_key = "abc"\n',
        "forbidden-secret",
      ],
      [
        "config.toml",
        'project_id = "p"\nbackend = "local"\nschema_version = 1\n',
        "client-connection-file",
      ],
      ["broken.toml", "schema_version = \n", "syntax"],
    ])("rejects %s without writing", async (name, text, code) => {
      await expect(
        run("import", { file: file(name, text), "expected-revision": "0" }),
      ).rejects.toMatchObject({ code });
      expect(await revision()).toBe(0);
    });

    it("imports the composed *.schema.toml files when no file is given", async () => {
      mockLoadComposedSchema.mockReturnValue({
        ok: true,
        definition: BOOTSTRAP,
        schemaVersion: 1,
        warnings: [],
      });
      await run("import", { "expected-revision": "0" });
      expect(await revision()).toBe(1);
    });
  });

  describe("export", () => {
    it("writes TOML to stdout with metadata", async () => {
      await bootstrap();
      await run("export", {});
      const text = stdout.join("");
      expect(text).toContain("# tila definitions export");
      expect(text).toContain('project_id = "test-proj"');
      expect(text).toContain("revision = 1");
      expect(text).toContain("exported_with = ");
    });

    it("round-trips through a YAML file into a fresh project", async () => {
      await bootstrap();
      const out = join(dir, "export.yaml");
      await run("export", { output: out });
      expect(readFileSync(out, "utf8")).toContain("tila_export:");
      const fresh = makeLocalProject();
      useProject(fresh);
      await run("import", { file: out, "expected-revision": "0" });
      const copied = (await fresh.getCurrentSchema()).definition ?? "";
      expect(canonicalJson(parseSchemaToml(copied))).toBe(
        canonicalJson(parseSchemaToml(BOOTSTRAP)),
      );
      expect(copied).not.toContain("tila_export");
    });

    it("refuses to overwrite without --force and fails with nothing applied", async () => {
      await expect(run("export", {})).rejects.toMatchObject({
        code: "not-found",
      });
      await bootstrap();
      const out = file("existing.toml", "keep");
      await expect(run("export", { output: out })).rejects.toMatchObject({
        code: "already-exists",
      });
      await run("export", { output: out, force: true, json: true });
      expect(json()).toMatchObject({
        result: { revision: 1, format: "toml", output: out },
      });
      expect(readFileSync(out, "utf8")).toContain("[tila_export]");
    });
  });

  describe("status", () => {
    it("compares local files with the server by declaration", async () => {
      await bootstrap();
      mockLoadComposedSchema.mockReturnValue({
        ok: true,
        definition: BOOTSTRAP,
        schemaVersion: 1,
        warnings: [],
      });
      await run("status", { json: true });
      expect(json().result).toMatchObject({
        status: "up-to-date",
        applied_revision: 1,
      });

      logs = [];
      mockLoadComposedSchema.mockReturnValue({
        ok: true,
        definition: BOOTSTRAP.replace(
          "retention_days = 30",
          "retention_days = 1",
        ),
        schemaVersion: 1,
        warnings: [],
      });
      await run("status", {});
      const text = logs.join("\n");
      expect(text).toContain("the server is authoritative");
      expect(text).toContain("Different (1):");
      expect(text).toContain("artifacts.plan");
      expect(text).not.toContain("pending apply");
    });
  });

  it("warns that legacy apply replaces the server definition", async () => {
    mockLoadComposedSchema.mockReturnValue({
      ok: true,
      definition: BOOTSTRAP,
      schemaVersion: 1,
      warnings: [],
    });
    await run("apply", {});
    expect(warnings.join("\n")).toContain("tila schema import");
  });
});
