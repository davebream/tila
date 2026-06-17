/**
 * Full local round-trip for `tila-sdk/local` under plain Node + better-sqlite3.
 *
 * Exercises the whole backend bundle createTilaLocal returns: a task is
 * created, claimed (fence), a record is set, an artifact is written and read
 * back, and the journal is listed — proving the embedded backends run on the
 * Node (better-sqlite3 + node:fs) driver, not just bun.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type TilaLocal,
  buildLocalResources,
  createTilaLocal,
} from "../../local/index";

describe("createTilaLocal — full local round-trip", () => {
  let dir: string;
  let local: TilaLocal;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tila-local-"));
    local = await createTilaLocal({
      dbPath: join(dir, "project.db"),
      artifactsPath: join(dir, "artifacts"),
      org: "test-org",
      project: "test-project",
      skipFilesystemCheck: true,
    });
  });

  afterEach(() => {
    local.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a task, claims it (fence), sets a record, round-trips an artifact, lists journal", async () => {
    // 1. Create a task.
    const task = await local.project.create({
      id: "task-1",
      type: "task",
      data: { title: "first task", status: "open" },
      created_by: "tester",
    });
    expect(task.id).toBe("task-1");

    // 2. Claim it — a monotonic fence is returned.
    const acquired = await local.project.acquire(
      "task:task-1",
      "machine-a",
      "user-a",
      "exclusive",
      30_000,
    );
    expect(acquired.fence).toBeGreaterThan(0);

    // 3. Create a record.
    const record = await local.project.createRecord({
      type: "note",
      key: "k1",
      value: { body: "hello" },
    });
    expect(record.type).toBe("note");
    const fetched = await local.project.getRecord("note", "k1");
    expect(fetched?.value).toMatchObject({ body: "hello" });

    // 4. Upload an artifact and read it back.
    const { key } = await local.artifacts.writeText("artifact body line\n", {
      kind: "text",
      mimeType: "text/plain",
    });
    const read = await local.artifacts.readText(key);
    expect(read?.content).toBe("artifact body line\n");

    // 5. List the journal — it has accumulated events from the above writes.
    const journal = await local.project.listJournal({ limit: 50 });
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.some((e) => e.kind.length > 0)).toBe(true);
  });

  it("records.put adapter creates then replaces fencelessly via the local surface", async () => {
    // Drive the local records adapter (the same surface createTila wires for
    // backend:"local") rather than EmbeddedProject directly, so the adapter's
    // put delegation + wire-shape mapping is exercised. Runtime put semantics
    // are also covered by EmbeddedProject.putRecord's Bun tests.
    const records = buildLocalResources(local.project, local.artifacts).records;

    const created = await records.put("note", "cfg/main", {
      value: { body: "v1" },
    });
    expect(created.ok).toBe(true);
    expect(created.revision).toBe(1);
    expect(created.fence).toBeGreaterThan(0);
    expect(created.record.value).toEqual({ body: "v1" });

    // Replace the same key with NO fence — the upsert bumps revision.
    const replaced = await records.put("note", "cfg/main", {
      value: { body: "v2" },
    });
    expect(replaced.revision).toBe(2);
    expect(replaced.record.value).toEqual({ body: "v2" });
    expect(replaced.fence).toBeGreaterThan(created.fence);

    const got = await records.get("note", "cfg/main");
    expect(got.record.value).toEqual({ body: "v2" });
  });

  it("tasks.archive honors the caller fence (stale fence rejected, parity with remote)", async () => {
    // Drive the local tasks adapter (the same surface createTila wires for
    // backend:"local") so the adapter's archive fence-handling is exercised end
    // to end, not just EmbeddedProject directly.
    const tasks = buildLocalResources(local.project, local.artifacts).tasks;

    await tasks.create("arch-1", "task", {
      title: "to archive",
      status: "open",
    });
    const acquired = await local.project.acquire(
      "task:arch-1",
      "machine-a",
      "user-a",
      "exclusive",
      30_000,
    );

    // Stale fence is REJECTED -- the local adapter must not silently
    // self-acquire a fresh fence (the bug this fix closes). Remote rejects the
    // same way; the task must remain un-archived.
    await expect(tasks.archive("arch-1", acquired.fence - 1)).rejects.toThrow();
    const stillOpen = await local.project.get("arch-1");
    expect(stillOpen?.archived).toBe(0);

    // Valid fence archives.
    const ok = await tasks.archive("arch-1", acquired.fence);
    expect(ok.ok).toBe(true);
    const archived = await local.project.get("arch-1");
    expect(archived?.archived).toBe(1);
  });

  it("persists across reopen (same db file, schema-identical)", async () => {
    await local.project.create({
      id: "persist-1",
      type: "task",
      data: { title: "persisted" },
      created_by: "tester",
    });
    local.close();

    const reopened = await createTilaLocal({
      dbPath: join(dir, "project.db"),
      artifactsPath: join(dir, "artifacts"),
      org: "test-org",
      project: "test-project",
      skipFilesystemCheck: true,
    });
    try {
      const got = await reopened.project.get("persist-1");
      expect(got?.id).toBe("persist-1");
    } finally {
      reopened.close();
      // beforeEach's `local` is already closed; replace it so afterEach's
      // close() is a harmless double-close on better-sqlite3 (idempotent).
      local = reopened;
    }
  });
});
