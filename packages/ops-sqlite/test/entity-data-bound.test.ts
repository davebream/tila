import { MAX_TASK_DATA_BYTES, taskDataBytes } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as attempts from "../src/attempt-ops";
import { SchemaWriteError } from "../src/constraint-ops";
import { acquire } from "../src/coordination-ops";
import {
  TaskDataTooLargeError,
  create,
  get,
  insertEntityInTransaction,
  update,
  updateInTransaction,
} from "../src/entity-ops";
import { mapProjectError } from "../src/error-map";
import { applySchema } from "../src/schema-ops";
import {
  attemptOrigin as attemptActor,
  authority,
  seedAttempt,
} from "./attempt-fixture";
import { type TestDb, createTestDb, testOrigin } from "./helpers";
import { lifecycleDefinition } from "./readiness-fixture";

let fixture: TestDb;
const origin = testOrigin("actor", "actor");

beforeEach(() => {
  fixture = createTestDb();
});
afterEach(() => fixture.rawDb.close());

function count(table: string): number {
  const row = fixture.rawDb
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

const fillTo = (bytes: number, extra: Record<string, unknown> = {}) => {
  const base = { ...extra, pad: "" };
  const room = bytes - taskDataBytes(base);
  return { ...extra, pad: "p".repeat(room) };
};

describe("create", () => {
  it("accepts data exactly at the limit and refuses one byte more", () => {
    const at = fillTo(MAX_TASK_DATA_BYTES);
    expect(taskDataBytes(at)).toBe(MAX_TASK_DATA_BYTES);
    expect(
      create(
        fixture.db,
        { id: "at", type: "task", data: at, created_by: "t" },
        1,
        origin,
      ).id,
    ).toBe("at");

    const over = { ...at, pad: `${at.pad}p` };
    const before = { entities: count("entities"), journal: count("journal") };
    expect(() =>
      create(
        fixture.db,
        { id: "over", type: "task", data: over, created_by: "t", tags: ["x"] },
        1,
        origin,
      ),
    ).toThrow(TaskDataTooLargeError);
    expect({ entities: count("entities"), journal: count("journal") }).toEqual(
      before,
    );
    expect(count("entity_tags")).toBe(0);
    expect(get(fixture.db, "over")).toBeNull();
  });

  it("refuses through the shared insert used by template instantiation", () => {
    expect(() =>
      fixture.db.transaction((tx) =>
        insertEntityInTransaction(
          tx,
          {
            id: "tpl",
            type: "task",
            data: fillTo(MAX_TASK_DATA_BYTES + 1),
            created_by: "t",
            tags: [],
          },
          1,
          Date.now(),
        ),
      ),
    ).toThrow(TaskDataTooLargeError);
    expect(count("entities")).toBe(0);
  });

  it("is mapped to a non-retryable 413 payload-too-large", () => {
    const error = new TaskDataTooLargeError(MAX_TASK_DATA_BYTES + 1);
    expect(mapProjectError(error)).toMatchObject({
      status: 413,
      code: "payload-too-large",
      retryable: false,
    });
    expect(error.message).toContain(String(MAX_TASK_DATA_BYTES));
  });

  it("keeps the class name the MCP server maps local errors by", () => {
    // tila-mcp-server's recoveryFor recognises this error by `name`.
    expect(new TaskDataTooLargeError(MAX_TASK_DATA_BYTES + 1).name).toBe(
      "TaskDataTooLargeError",
    );
  });
});

describe("update", () => {
  it("checks the merged data rather than the patch", () => {
    create(
      fixture.db,
      {
        id: "m",
        type: "task",
        data: { a: "e".repeat(200_000) },
        created_by: "t",
      },
      1,
      origin,
    );
    const fence = acquire(fixture.db, "m", origin, "exclusive", 60_000).fence;
    const journal = count("journal");

    expect(() =>
      update(fixture.db, "m", { b: "p".repeat(100_000) }, fence, origin),
    ).toThrow(TaskDataTooLargeError);

    expect(get(fixture.db, "m")?.data).toEqual({ a: "e".repeat(200_000) });
    expect(count("journal")).toBe(journal);
  });
});

describe("a task whose data is already over the limit", () => {
  beforeEach(() => {
    applySchema(fixture.db, lifecycleDefinition, "test");
  });

  /** An `issue` row written past the ops layer, as before the bound existed. */
  function seedIssue(id: string, data: Record<string, unknown>) {
    fixture.rawDb
      .prepare(
        "INSERT INTO entities (id, type, schema_version, data, archived, created_at, updated_at, created_by) VALUES (?, 'issue', 1, ?, 0, 1, 1, 'legacy')",
      )
      .run(id, JSON.stringify(data));
    return acquire(fixture.db, id, origin, "exclusive", 60_000).fence;
  }

  const legacy = (phase = "todo") => ({ phase, big: "L".repeat(300_000) });
  const transition = (
    id: string,
    fence: number,
    data: Record<string, unknown>,
    attemptId?: string,
  ) =>
    fixture.db.transaction((tx) =>
      updateInTransaction(
        tx,
        id,
        data,
        fence,
        origin,
        undefined,
        Date.now(),
        attemptId,
      ),
    );

  it("lets an attempt move the lifecycle field to a state its definition names", () => {
    const start = seedIssue("start", legacy());
    expect(
      transition("start", start, { phase: "working" }, "attempt-1").data,
    ).toMatchObject({ phase: "working" });

    const done = seedIssue("done", legacy("working"));
    expect(
      transition("done", done, { phase: "shipped" }, "attempt-1").data,
    ).toMatchObject({ phase: "shipped" });
  });

  it("lets that transition cross the limit when the task sat exactly on it", () => {
    const fence = seedIssue(
      "margin",
      fillTo(MAX_TASK_DATA_BYTES, { phase: "todo" }),
    );
    expect(taskDataBytes(get(fixture.db, "margin")?.data ?? {})).toBe(
      MAX_TASK_DATA_BYTES,
    );
    // "working" is longer than "todo": the same write by a client is refused.
    expect(() =>
      update(fixture.db, "margin", { phase: "working" }, fence, origin),
    ).toThrow(TaskDataTooLargeError);
    expect(
      transition("margin", fence, { phase: "working" }, "attempt-1").data.phase,
    ).toBe("working");
  });

  it("does not exempt an ordinary update that sets the same lifecycle state", () => {
    const fence = seedIssue("plain", legacy());
    expect(() =>
      update(fixture.db, "plain", { phase: "working" }, fence, origin),
    ).toThrow(TaskDataTooLargeError);
    expect(get(fixture.db, "plain")?.data.phase).toBe("todo");
  });

  it.each([
    ["another key beside the lifecycle field", { phase: "working", note: "n" }],
    ["a different field alone", { big: "G".repeat(300_001) }],
    ["a state the definition does not name", { phase: "bogus" }],
    ["an arbitrary large lifecycle value", { phase: "w".repeat(400_000) }],
  ])("keeps an attempt id from carrying %s past the bound", (_label, patch) => {
    const fence = seedIssue("forged", legacy());
    expect(() => transition("forged", fence, patch, "attempt-forged")).toThrow(
      TaskDataTooLargeError,
    );
    expect(get(fixture.db, "forged")?.data).toEqual(legacy());
  });

  it("leaves a non-string lifecycle value to the schema check", () => {
    // It shrinks the data, so the bound lets it through; the schema refuses it.
    const fence = seedIssue("numeric", legacy());
    expect(() =>
      transition("numeric", fence, { phase: 7 }, "attempt-forged"),
    ).toThrow(SchemaWriteError);
    expect(get(fixture.db, "numeric")?.data).toEqual(legacy());
  });

  it("still refuses growth on a task within the limit when the attempt id carries other data", () => {
    const fence = seedIssue("small", { phase: "todo" });
    expect(() =>
      transition(
        "small",
        fence,
        { phase: "working", big: "B".repeat(300_000) },
        "a",
      ),
    ).toThrow(TaskDataTooLargeError);
    expect(get(fixture.db, "small")?.data).toEqual({ phase: "todo" });
  });

  it("does not strand a real attempt on an oversized task", () => {
    const { db, rawDb } = fixture;
    const attempt = seedAttempt(db);
    rawDb
      .prepare("UPDATE entities SET data = ? WHERE id = 'task'")
      .run(JSON.stringify(legacy()));
    expect(taskDataBytes(get(db, "task")?.data ?? {})).toBeGreaterThan(
      MAX_TASK_DATA_BYTES,
    );

    let current = attempts.accept(
      db,
      attempt.id,
      authority(attempt),
      attemptActor,
    ).attempt;
    expect(get(db, "task")?.data.phase).toBe("working");

    current = attempts.started(
      db,
      current.id,
      {
        ...authority(current),
        session: { provider: "fixture", id: "session" },
      },
      attemptActor,
    ).attempt;
    const result = attempts.finish(
      db,
      current.id,
      {
        ...authority(current),
        outcome: {
          status: "success",
          execution_stopped: true,
          evidence: [],
          unresolved_external_execution: false,
        },
      },
      attemptActor,
    );
    expect(result.attempt.state).toBe("terminal");
    expect(get(db, "task")?.data).toEqual(legacy("shipped"));
  });
});
