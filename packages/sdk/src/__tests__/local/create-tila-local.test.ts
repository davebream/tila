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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTila } from "../../client";

import type { TilaApiError } from "../../client";
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
    vi.restoreAllMocks();
  });

  it("reports unsupported agent operations in embedded mode", async () => {
    const agents = buildLocalResources(local.project, local.artifacts).agents;
    await expect(agents.list()).rejects.toMatchObject({
      code: "unsupported-capability",
      retryable: false,
    });
    await expect(agents.get("worker")).rejects.toMatchObject({
      code: "unsupported-capability",
    });
  });

  it("explicitly rejects authenticated report append locally without changing the journal", async () => {
    const journal = buildLocalResources(local.project, local.artifacts).journal;
    const before = await journal.query();
    await expect(
      journal.append(
        {
          event_name: "pipeline.tests_passed",
          event_version: 1,
          target: { kind: "project" },
          data: {},
        },
        { idempotencyKey: "local" },
      ),
    ).rejects.toMatchObject({
      code: "unsupported-capability",
      retryable: false,
    });
    expect(await journal.query()).toEqual(before);
  });

  it("previews, conditionally applies, replays and reads real configuration history", async () => {
    const { schema } = buildLocalResources(local.project, local.artifacts);
    const definition = "schema_version = 1\n[work_units.task]\n";
    const review = await schema.preview(definition);
    expect(review.revision).toBe(0);
    const options = {
      expected_revision: review.revision,
      idempotency_key: "first",
    };
    const result = await schema.apply(definition, undefined, options);
    expect(result.revision).toBe(1);
    expect(await schema.apply(definition, undefined, options)).toEqual(result);
    await expect(
      schema.apply(definition, undefined, { expected_revision: 0 }),
    ).rejects.toMatchObject({ status: 412, code: "schema-revision-conflict" });
    expect((await schema.history()).entries).toHaveLength(1);
    const removed = "schema_version = 1\nwork_units = {}";
    await expect(schema.apply(removed)).rejects.toMatchObject({
      status: 422,
      code: "schema-destructive",
    });
    expect((await schema.get()).revision).toBe(1);
    await expect(
      schema.apply(definition, undefined, { expected_revision: -1 }),
    ).rejects.toMatchObject({ status: 400, code: "validation-error" });
  });

  it("warns visibly for real embedded applies and retains one durable event on retry and no-change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { schema, journal } = buildLocalResources(
      local.project,
      local.artifacts,
    );
    const definition = "schema_version = 1\n[work_units.task]\n";
    const options = { idempotency_key: "legacy" };
    const first = await schema.apply(definition, undefined, options);
    expect(first).toMatchObject({
      ok: true,
      revision: 1,
      warnings: [
        {
          code: "schema-revision-deprecated",
          observed_revision: 0,
          result_revision: 1,
        },
      ],
    });
    expect(await schema.apply(definition, undefined, options)).toEqual(first);
    expect(await schema.apply(definition)).toMatchObject({
      noChange: true,
      warnings: [
        {
          observed_revision: 1,
          result_revision: 1,
        },
      ],
    });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("expected_revision"),
    );
    expect(log).not.toHaveBeenCalled();
    expect(
      (await journal.query({ kind: "schema.revisionless_applied" })).events,
    ).toHaveLength(1);
    expect((await schema.history()).entries).toHaveLength(1);
    await expect(schema.apply("schema_version = [")).rejects.toBeDefined();
    await expect(
      schema.apply("schema_version = 1\nwork_units = {}"),
    ).rejects.toMatchObject({ code: "schema-destructive" });
    await schema.apply(definition, undefined, { expected_revision: 1 });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("accepts a warning sink through createTila's local entry", async () => {
    const sink = vi.fn();
    const facade = await createTila(
      {
        backend: "local",
        project_id: "test-project",
        schema_version: 1,
        tila_version: "0.0.0",
        created_at: new Date(0).toISOString(),
        local: {
          db_path: join(dir, "project.db"),
          artifacts_path: join(dir, "artifacts"),
          org: "test-org",
        },
      },
      undefined,
      { warningSink: sink },
    );
    try {
      const result = await facade.schema.apply(
        "schema_version = 1\n[work_units.task]\n",
      );
      expect(sink).toHaveBeenCalledExactlyOnceWith(result.warnings?.[0]);
    } finally {
      facade.close();
    }
  });

  it.each([
    ["sync", "throw"],
    ["async", "throw"],
    ["default", "throw"],
    ["sync", "reject"],
    ["async", "reject"],
    ["default", "reject"],
  ])(
    "preserves committed local apply and replay when %s diagnostics and a %s fallback fail",
    async (custom, fallback) => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        if (fallback === "reject")
          return Promise.reject(new Error("async console failure"));
        throw new Error("console failure");
      });
      const sink =
        custom === "default"
          ? undefined
          : custom === "async"
            ? async () => {
                throw new Error("async sink failure");
              }
            : () => {
                throw new Error("sink failure");
              };
      const { schema, journal } = buildLocalResources(
        local.project,
        local.artifacts,
        sink,
      );
      const definition = "schema_version = 1\n[work_units.task]\n";
      const options = { idempotency_key: "diagnostic-failure" };
      try {
        const result = await schema.apply(definition, undefined, options);
        expect(result).toMatchObject({
          ok: true,
          revision: 1,
          warnings: [{ code: "schema-revision-deprecated" }],
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect((await schema.get()).revision).toBe(1);
        expect(await schema.apply(definition, undefined, options)).toEqual(
          result,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect((await schema.history()).entries).toHaveLength(1);
        expect(
          (await journal.query({ kind: "schema.revisionless_applied" })).events,
        ).toHaveLength(1);
        expect(unhandled).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );

  it("exposes version history, metadata and append-only restore under Node", async () => {
    const claim = await local.project.acquire(
      "artifact:report",
      "exclusive",
      60_000,
    );
    const artifacts = buildLocalResources(
      local.project,
      local.artifacts,
    ).artifacts;
    const first = await artifacts.writeText("first", {
      kind: "text",
      lineageId: "report",
      lineageFence: claim.fence,
      tags: ["Env:Prod"],
    });
    await artifacts.writeText("second", {
      kind: "text",
      lineageId: "report",
      lineageFence: claim.fence,
    });
    const duplicate = await artifacts.writeText("first", {
      kind: "text",
      lineageId: "report",
      lineageFence: claim.fence,
      tags: [],
    });
    expect(duplicate).toMatchObject({ key: first.key, deduplicated: true });
    const restored = await artifacts.restore(first.key, {
      fence: claim.fence,
      idempotencyKey: "restore-once",
    });
    expect((await artifacts.meta(restored.key)).pointer).toMatchObject({
      revision: 3,
      tags: ["env:prod"],
      restored_from: first.key,
    });
    expect(
      (await artifacts.history(first.key)).items.map((p) => p.revision),
    ).toEqual([3, 2, 1]);
    expect((await artifacts.readText(restored.key)).content).toBe("first");
    expect(
      await artifacts.restore(first.key, {
        fence: claim.fence,
        idempotencyKey: "restore-once",
      }),
    ).toEqual(restored);
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

  it("signals adapter enforces the same participant-scoped ack errors as remote", async () => {
    const senderSignals = buildLocalResources(
      local.project,
      local.artifacts,
    ).signals;
    const sent = await senderSignals.send({
      target: {
        type: "participant",
        principal_id: "local:recipient",
        participant_id: "recipient-1",
      },
      kind: "request",
    });

    await expect(senderSignals.ack(sent.id)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    } satisfies Partial<TilaApiError>);

    const recipient = await createTilaLocal({
      dbPath: join(dir, "project.db"),
      artifactsPath: join(dir, "artifacts"),
      project: "test-project",
      skipFilesystemCheck: true,
      identity: {
        principal_id: "local:recipient",
        participant_id: "recipient-1",
        environment: { client_name: "recipient-test" },
      },
    });
    try {
      const recipientSignals = buildLocalResources(
        recipient.project,
        recipient.artifacts,
      ).signals;
      await expect(recipientSignals.ack(sent.id)).resolves.toEqual({
        ok: true,
      });
      await expect(recipientSignals.ack("sig_missing")).rejects.toMatchObject({
        status: 404,
        code: "not-found",
      } satisfies Partial<TilaApiError>);
    } finally {
      recipient.close();
    }
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
