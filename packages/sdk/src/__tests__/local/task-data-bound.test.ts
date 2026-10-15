/**
 * The task data bound is enforced by the shared ops layer, so the embedded
 * backend that `tila-sdk/local` and the CLI's local mode run refuses an
 * oversized task the same way the Worker does: before the write, as a typed
 * error that maps to a non-retryable 413 `payload-too-large`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDataTooLargeError, mapProjectError } from "@tila/ops-sqlite";
import { MAX_TASK_DATA_BYTES, taskDataBytes } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TilaLocal, createTilaLocal } from "../../local/index";

describe("local task data bound", () => {
  let dir: string;
  let local: TilaLocal;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tila-local-bound-"));
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

  const atLimit = { d: "a".repeat(MAX_TASK_DATA_BYTES - 8) };

  it("accepts data exactly at the limit and refuses one byte more", async () => {
    expect(taskDataBytes(atLimit)).toBe(MAX_TASK_DATA_BYTES);
    const created = await local.project.create({
      id: "at",
      type: "task",
      data: atLimit,
      created_by: "local",
    });
    expect(created.id).toBe("at");

    const journal = await local.project.getJournalCursor();
    const refusal = await local.project
      .create({
        id: "over",
        type: "task",
        data: { d: `${atLimit.d}a` },
        created_by: "local",
      })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(TaskDataTooLargeError);
    expect(mapProjectError(refusal as Error)).toMatchObject({
      status: 413,
      code: "payload-too-large",
      retryable: false,
    });
    expect(await local.project.get("over")).toBeNull();
    expect(await local.project.getJournalCursor()).toEqual(journal);
  });

  it("counts UTF-8 bytes, not characters", async () => {
    await expect(
      local.project.create({
        id: "multibyte",
        type: "task",
        data: { d: "€".repeat(87_379) },
        created_by: "local",
      }),
    ).rejects.toBeInstanceOf(TaskDataTooLargeError);
  });

  it("checks the merged data of an update, not the patch", async () => {
    await local.project.create({
      id: "merge",
      type: "task",
      data: { a: "e".repeat(200_000) },
      created_by: "local",
    });

    await expect(
      local.project.update("merge", { b: "p".repeat(100_000) }),
    ).rejects.toBeInstanceOf(TaskDataTooLargeError);

    expect((await local.project.get("merge"))?.data).toEqual({
      a: "e".repeat(200_000),
    });
  });
});
