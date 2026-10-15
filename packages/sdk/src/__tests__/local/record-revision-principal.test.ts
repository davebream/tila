/**
 * Record history authorship under the Node embedded backend (`tila-sdk/local`).
 *
 * The embedded store runs the same shared migrations and record ops as the
 * Durable Object, so this proves migration 43 applies to an existing local
 * database and that a local write is attributed to the client's principal.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type TilaLocal,
  buildLocalResources,
  createTilaLocal,
} from "../../local/index";

const identity = (principal: string) => ({
  principal_id: principal,
  participant_id: "participant-1",
  environment: { client_name: "sdk" },
});

describe("local record history authorship", () => {
  let dir: string;
  let dbPath: string;
  const open = (principal: string): Promise<TilaLocal> =>
    createTilaLocal({
      dbPath,
      artifactsPath: join(dir, "artifacts"),
      project: "p",
      skipFilesystemCheck: true,
      identity: identity(principal),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tila-revision-principal-"));
    dbPath = join(dir, "project.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("attributes a revision to the client principal with no token", async () => {
    const local = await open("user:alice");
    try {
      const created = await local.project.createRecord({
        type: "note",
        key: "k1",
        value: { body: "one" },
      });
      await local.project.setRecord({
        type: "note",
        key: "k1",
        value: { body: "two" },
        fence: created.fence,
      });

      const history = await buildLocalResources(
        local.project,
        local.artifacts,
      ).records.history("note", "k1");
      expect(history.items.map((i) => i.revision)).toEqual([2, 1]);
      for (const item of history.items) {
        expect(item).toMatchObject({
          principal_id: "user:alice",
          // A local client holds no D1 credential.
          token_id: null,
          actor: "local",
        });
      }
    } finally {
      local.close();
    }
  });

  it("upgrades a database written before migration 43 without inventing authors", async () => {
    const before = await open("user:alice");
    const created = await before.project.createRecord({
      type: "note",
      key: "k1",
      value: { body: "old" },
    });
    before.close();

    // Return the file to what the previous release left behind: no column and
    // no applied version 43. SQLite can drop the (unindexed) column directly.
    const raw = new Database(dbPath);
    raw.exec("ALTER TABLE record_revisions DROP COLUMN principal_id");
    raw.exec("DELETE FROM _migrations WHERE version = 43");
    const columns = raw
      .prepare("PRAGMA table_info(record_revisions)")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("principal_id");
    raw.close();

    // Another principal reopens it: only new writes may carry that principal.
    const after = await open("user:bob");
    try {
      const upgraded = new Database(dbPath, { readonly: true });
      expect(
        (
          upgraded
            .prepare("SELECT version FROM _migrations WHERE version = 43")
            .all() as unknown[]
        ).length,
      ).toBe(1);
      upgraded.close();

      await after.project.setRecord({
        type: "note",
        key: "k1",
        value: { body: "new" },
        fence: created.fence,
      });
      const page = await after.project.listRecordHistory("note", "k1");
      expect(
        page.items.map((i) => [i.revision, i.principal_id, i.token_id]),
      ).toEqual([
        [2, "user:bob", null],
        // The journal still names alice for revision 1; it is not consulted.
        [1, null, null],
      ]);
    } finally {
      after.close();
    }
  });

  it("reopens an already upgraded database without changing stored authors", async () => {
    const first = await open("user:alice");
    await first.project.createRecord({
      type: "note",
      key: "k1",
      value: { body: "one" },
    });
    first.close();

    const second = await open("user:bob");
    try {
      const page = await second.project.listRecordHistory("note", "k1");
      expect(page.items.map((i) => i.principal_id)).toEqual(["user:alice"]);
    } finally {
      second.close();
    }
  });
});
