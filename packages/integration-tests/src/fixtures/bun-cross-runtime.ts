/**
 * Bun-side fixture for the cross-runtime interop test
 * (`src/local-cross-runtime.test.ts`).
 *
 * This script is spawned by the Node-driven vitest test via `spawnSync("bun", …)`.
 * It exercises the BUN embedded path (`@tila/backend-local` →
 * `LocalProject.open`/`LocalArtifactBackend`, which use `bun:sqlite`) against a
 * DB file the Node side also opens (via `tila-sdk/local` → better-sqlite3). The
 * single DB file is the interop boundary.
 *
 * It MUST run under `bun` (it imports `bun:sqlite` transitively). It selects an
 * operation via `process.env.OP` and emits a single JSON line on stdout so the
 * parent test can parse the result deterministically.
 *
 * Operations:
 *  - `write-task`       create task T-1 at $DB; print {created}
 *  - `dump-schema`      open $DB, print {master, migrations} (sqlite_master DDL +
 *                       _migrations rows) for the schema-identity assertion
 *  - `read-record`      open $DB, read record (note/$KEY); print {record}
 *  - `read-task`        open $DB, read task T-1; print {task}
 *  - `write-artifact`   write a multi-line text artifact ($KIND/$RESOURCE) at $DB;
 *                       print {key}
 *  - `grep-artifact`    grepArtifacts($PATTERN) over $DB; print {lines:[{key,line,text}]}
 */

import {
  LocalArtifactBackend,
  LocalProject,
  createLocalConnection,
} from "@tila/backend-local";

const DB = requireEnv("DB");
const ARTIFACTS = process.env.ARTIFACTS ?? `${DB}.artifacts`;
const ORG = process.env.ORG ?? "x-org";
const PROJECT = process.env.PROJECT ?? "x-proj";
const OP = requireEnv("OP");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`bun fixture: missing env ${name}`);
  return v;
}

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<void> {
  switch (OP) {
    case "write-task": {
      const proj = LocalProject.open(DB, ORG, PROJECT, {
        skipFilesystemCheck: true,
      });
      const created = await proj.create({
        id: "T-1",
        type: "task",
        data: { title: "from bun", status: "open" },
        created_by: "bun",
      });
      proj.close();
      emit({ created: created.id });
      return;
    }

    case "dump-schema": {
      // Open with the SAME connection path the bun host uses (PRAGMAs +
      // embedded migrations), then read sqlite_master + _migrations off the raw
      // bun:sqlite client. This is the bun side of the schema-identity check.
      const db = createLocalConnection(DB, ORG, PROJECT, {
        skipFilesystemCheck: true,
      });
      const raw = db.$client;
      const master = raw
        .query(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ type: string; name: string; sql: string | null }>;
      const migrations = raw
        .query("SELECT version FROM _migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      raw.close();
      emit({ master, migrations: migrations.map((m) => m.version) });
      return;
    }

    case "read-task": {
      const proj = LocalProject.open(DB, ORG, PROJECT, {
        skipFilesystemCheck: true,
      });
      const task = await proj.get("T-1");
      proj.close();
      emit({ task: task ? { id: task.id, data: task.data } : null });
      return;
    }

    case "read-record": {
      const key = requireEnv("KEY");
      const proj = LocalProject.open(DB, ORG, PROJECT, {
        skipFilesystemCheck: true,
      });
      const record = await proj.getRecord("note", key);
      proj.close();
      emit({
        record: record ? { key: record.key, value: record.value } : null,
      });
      return;
    }

    case "write-artifact": {
      const kind = process.env.KIND ?? "log";
      // RESOURCE is optional: when set it FK-references an existing entity, so
      // leave it unset for a source (resource-less) artifact.
      const resource = process.env.RESOURCE || undefined;
      const content = requireEnv("CONTENT");
      const db = createLocalConnection(DB, ORG, PROJECT, {
        skipFilesystemCheck: true,
      });
      const artifacts = new LocalArtifactBackend(db, ARTIFACTS, ORG, PROJECT);
      const { key } = await artifacts.writeText(content, { kind, resource });
      db.$client.close();
      emit({ key });
      return;
    }

    case "grep-artifact": {
      const pattern = requireEnv("PATTERN");
      const db = createLocalConnection(DB, ORG, PROJECT, {
        skipFilesystemCheck: true,
      });
      const artifacts = new LocalArtifactBackend(db, ARTIFACTS, ORG, PROJECT);
      const res = await artifacts.grepArtifacts({ pattern });
      db.$client.close();
      // Flatten to a stable, driver-independent shape: every (key,line,text).
      const lines = res.results.flatMap((r) =>
        r.lines.map((l) => ({ key: r.key, line: l.line, text: l.text })),
      );
      emit({ lines });
      return;
    }

    default:
      throw new Error(`bun fixture: unknown OP ${OP}`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
