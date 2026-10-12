import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, it } from "vitest";
import { create } from "../src/entity-ops";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "../src/migrations-sql";
import * as queue from "../src/queue-ops";
import * as schema from "../src/schema";
import { applySchema } from "../src/schema-ops";
import { attemptOrigin } from "./attempt-fixture";
import { runMigration } from "./helpers";
import { lifecycleDefinition } from "./readiness-fixture";

it("Node and Bun processes contend safely on one WAL database through embedded busy retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-queue-contention-"));
  const file = join(root, "project.sqlite");
  const barrier = join(root, "start");
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.exec(MIGRATION_BOOTSTRAP);
  for (const migration of MIGRATIONS) runMigration(raw, migration);
  const db = drizzle(raw, { schema });
  applySchema(db, lifecycleDefinition, "fixture");
  queue.configure(
    db,
    {
      idempotency_key: "configure",
      expected_revision: 0,
      enabled: true,
      paused: false,
      execution_limit: 20,
    },
    attemptOrigin,
    true,
  );
  for (let i = 0; i < 100; i++) {
    create(
      db,
      {
        id: `task-${i}`,
        type: "issue",
        data: { phase: "todo" },
        created_by: "fixture",
      },
      1,
      attemptOrigin,
    );
    queue.enroll(
      db,
      { idempotency_key: `enroll-${i}`, task_id: `task-${i}` },
      attemptOrigin,
    );
  }
  const fixture = fileURLToPath(
    new URL("./fixtures/queue-consumer.ts", import.meta.url),
  );
  const children = [
    spawn(process.execPath, [
      "--import",
      "tsx",
      fixture,
      file,
      barrier,
      "node",
    ]),
    spawn("bun", [fixture, file, barrier, "bun"]),
  ];
  const records = children.map((child) => {
    let output = "";
    let errors = "";
    let readyResolve: () => void = () => {};
    let readyReject: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    child.stdout.on("data", (data) => {
      output += data.toString();
      if (output.includes("ready\n")) readyResolve();
    });
    child.stderr.on("data", (data) => {
      errors += data.toString();
    });
    const done = new Promise<{ grants: string[] }>((resolve, reject) => {
      child.on("error", (error) => {
        readyReject(error);
        reject(error);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const error = new Error(errors || `Consumer exited ${code}`);
          readyReject(error);
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(output.trim().split("\n").at(-1) ?? "{}"));
        } catch (error) {
          reject(error);
        }
      });
    });
    // Observe failures even when startup fails before the barrier opens.
    void done.catch(() => {});
    return { ready, done };
  });
  try {
    await Promise.all(records.map((r) => r.ready));
    writeFileSync(barrier, "start");
    const results = await Promise.all(records.map((r) => r.done));
    const grants = results.flatMap((r) => r.grants);
    expect(grants).toHaveLength(20);
    expect(new Set(grants).size).toBe(20);
    expect(queue.occupancy(db)).toEqual({ execution: 20, wip: 20 });
    expect(db.select().from(schema.queueOperationReceipts).all()).toHaveLength(
      201,
    );
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
