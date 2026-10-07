import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactOps,
  coordinationOps,
  journalArchiveOps,
} from "@tila/ops-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { exportProjectBackup, importProjectBackup } from "../../backup";
import {
  NodeBlobStore,
  buildLocalResources,
  createTilaLocal,
} from "../../local";

const roots: string[] = [];
const identity = {
  principal_id: "local:org",
  participant_id: "session",
  environment: { client_name: "node" },
};
function options() {
  const dir = mkdtempSync(join(tmpdir(), "tila-continuity-"));
  roots.push(dir);
  return {
    dbPath: join(dir, "project.db"),
    artifactsPath: join(dir, "artifacts"),
    org: "org",
    project: "project",
    identity,
    skipFilesystemCheck: true,
  };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("local continuity", () => {
  it("resumes across connections, replays local archive blobs and leaves cursors explicit", async () => {
    const opts = options();
    let local = await createTilaLocal(opts);
    try {
      let facade = buildLocalResources(local.project, local.artifacts);
      const input = {
        id: crypto.randomUUID(),
        summary: "Node findings",
        based_on_seq: 0,
        references: [{ type: "task" as const, id: "work" }],
      };
      const saved = await facade.handoffs.create(input);
      expect(await facade.handoffs.create(input)).toEqual(saved);
      const archived = journalArchiveOps.getArchivableEvents(
        local.project.getDb(),
      );
      await new NodeBlobStore(opts.artifactsPath).write(
        "journal-archive/project/2026/01.part-1.jsonl",
        archived.events.map((row) => JSON.stringify(row)).join("\n"),
      );
      journalArchiveOps.markArchived(
        local.project.getDb(),
        archived.throughSeq,
      );
      local.close();
      local = await createTilaLocal(opts);
      facade = buildLocalResources(local.project, local.artifacts);
      const resumed = await facade.reentry({ handoff_id: saved.handoff.id });
      expect(resumed.handoff).toEqual(saved.handoff);
      expect(resumed.changes.events.map((row) => row.kind)).toEqual([
        "handoff.created",
      ]);
      expect((await facade.journal.getCursor()).cursor.seq).toBe(0);
      await facade.journal.acknowledge({ seq: resumed.changes.next_after_seq });
      expect((await facade.reentry()).changes.events).toEqual([]);
    } finally {
      local.close();
    }
  });
  it("preserves handoffs and acknowledged cursors through backup and restore", async () => {
    const opts = options();
    const local = await createTilaLocal(opts);
    const handoff = await local.project.createHandoff({
      id: crypto.randomUUID(),
      summary: "Saved context",
      based_on_seq: 0,
      references: [{ type: "record", record_type: "note", key: "work" }],
    });
    await local.project.acknowledgeJournal({ seq: handoff.created_seq });
    local.close();
    const archive = join(roots[roots.length - 1], "project.tila-backup");
    await exportProjectBackup({
      source: {
        backend: "local",
        projectId: opts.project,
        dbPath: opts.dbPath,
        artifactsPath: opts.artifactsPath,
      },
      output: archive,
    });
    const destination = options();
    await importProjectBackup({
      archive,
      destination: {
        backend: "local",
        projectId: destination.project,
        dbPath: destination.dbPath,
        artifactsPath: destination.artifactsPath,
      },
    });
    const restored = await createTilaLocal(destination);
    try {
      expect(await restored.project.getJournalCursor()).toMatchObject({
        seq: handoff.created_seq,
      });
      const resumed = await restored.project.reentry({
        resource: "record:note:work",
      });
      expect(resumed.handoff).toEqual(handoff);
      expect(resumed.changes.events).toEqual([]);
    } finally {
      restored.close();
    }
  });
});

it("backs up metadata and immutable lifecycle records after all revision pointers were collected", async () => {
  const opts = options();
  const local = await createTilaLocal(opts);
  let key: string;
  try {
    const claim = coordinationOps.acquire(
      local.project.getDb(),
      "artifact:report",
      {
        principalId: identity.principal_id,
        participantId: identity.participant_id,
        actor: identity.principal_id,
        environment: identity.environment,
      },
      "exclusive",
      60_000,
    );
    const artifact = await local.artifacts.writeText("retained history", {
      kind: "report",
      lineageId: "report",
      lineageFence: claim.fence,
    });
    key = artifact.key;
    await local.artifacts.destroyLineage("report", { fence: claim.fence });
    await local.artifacts.drainLifecycle();
    artifactOps.deleteTombstonedPointers(
      local.project.getDb(),
      Date.now() + 8 * 86_400_000,
    );
  } finally {
    local.close();
  }
  const archive = join(roots[roots.length - 1], "lifecycle.tila-backup");
  await exportProjectBackup({
    source: {
      backend: "local",
      projectId: opts.project,
      dbPath: opts.dbPath,
      artifactsPath: opts.artifactsPath,
    },
    output: archive,
  });
  const destination = options();
  await importProjectBackup({
    archive,
    destination: {
      backend: "local",
      projectId: destination.project,
      dbPath: destination.dbPath,
      artifactsPath: destination.artifactsPath,
    },
  });
  const restored = await createTilaLocal(destination);
  try {
    expect((await restored.artifacts.meta(key)).pointer).toMatchObject({
      tombstoned: 1,
    });
    expect((await restored.artifacts.history(key)).meta.total).toBe(1);
    await expect(restored.artifacts.readText(key)).rejects.toMatchObject({
      status: 410,
    });
    const blobs = new NodeBlobStore(destination.artifactsPath);
    expect(await blobs.exists(`${key}.commit.json`)).toBe(true);
    expect(await blobs.exists(`${key}.tombstone.json`)).toBe(true);
    expect(await blobs.exists(`${key}.deleted.json`)).toBe(true);
    expect(
      await blobs.exists(
        `${key.split("/").slice(0, 3).join("/")}/destroy.json`,
      ),
    ).toBe(true);
    expect(await blobs.exists(key)).toBe(false);
  } finally {
    restored.close();
  }
});
