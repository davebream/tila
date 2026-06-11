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

import { type TilaLocal, createTilaLocal } from "../../local/index";

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
