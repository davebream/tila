import {
  type QueueInspection,
  QueueInspectionSchema,
  QueueListQuerySchema,
} from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as entities from "../src/entity-ops";
import * as queue from "../src/queue-ops";
import * as schema from "../src/schema";
import { applySchema } from "../src/schema-ops";
import { attemptOrigin as origin } from "./attempt-fixture";
import { type TestDb, createTestDb } from "./helpers";
import {
  compactDefinition,
  jsonBytes,
  managedWork,
  prose,
} from "./queue-compact-fixture";

const NOW = 1_800_000_000_000;

let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
  applySchema(fixture.db, compactDefinition, "test");
});
afterEach(() => fixture.rawDb.close());

const key = () => ({ idempotency_key: crypto.randomUUID() });
function seed(
  count: number,
  data: (index: number) => Record<string, unknown>,
  type = "issue",
) {
  const { db } = fixture;
  queue.configure(
    db,
    {
      ...key(),
      expected_revision: queue.policy(db).revision,
      enabled: true,
      paused: false,
      execution_limit: 20,
    },
    origin,
    true,
    NOW,
  );
  for (let index = 0; index < count; index++) {
    const id = `${type}-${index}`;
    entities.create(
      db,
      { id, type, data: data(index), created_by: "test" },
      1,
      origin,
    );
    queue.enroll(db, { ...key(), task_id: id }, origin, NOW + index);
  }
}
const inspect = (
  query: Parameters<typeof queue.inspect>[1] = {},
  allows?: Parameters<typeof queue.inspect>[2],
) => queue.inspect(fixture.db, query, allows, NOW);

describe("compact queue listing", () => {
  it("returns the full task unchanged, byte for byte, with compact absent or false", () => {
    seed(3, (index) => ({
      phase: "todo",
      title: `Work ${index}`,
      description: prose(index, 400),
    }));
    const absent = inspect();
    const explicit = inspect({ compact: false });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(absent));
    const rows = fixture.db.select().from(schema.entities).all();
    for (const view of absent.entries) {
      const row = rows.find((candidate) => candidate.id === view.entry.task_id);
      expect(view.task).toEqual({
        ...row,
        data: JSON.parse(row?.data ?? "{}"),
        tags: [],
      });
    }
  });

  it("narrows only task.data to title, name and the declared lifecycle field", () => {
    seed(2, (index) => ({
      phase: "todo",
      title: `Work ${index}`,
      name: `work-${index}`,
      description: prose(index, 600),
      acceptance: "All callers compile and tests pass.",
    }));
    const compact = inspect({ compact: true });
    expect(compact.entries).toHaveLength(2);
    for (const view of compact.entries) {
      const index = view.entry.task_id.split("-")[1];
      expect(view.task).toEqual({
        id: view.entry.task_id,
        type: "issue",
        data: { phase: "todo", title: `Work ${index}`, name: `work-${index}` },
      });
    }
  });

  it("keeps every other part of the inspection identical to the full listing", () => {
    seed(5, (index) => ({
      phase: "todo",
      title: `Work ${index}`,
      description: prose(index, 300),
    }));
    const full = inspect();
    const compact = inspect({ compact: true });
    const narrowed = {
      ...full,
      entries: full.entries.map((view) => ({
        ...view,
        task: view.task && {
          id: view.task.id,
          type: view.task.type,
          data: {
            phase: view.task.data.phase,
            title: view.task.data.title,
          },
        },
      })),
    };
    expect(compact).toEqual(narrowed);
    expect(compact.total).toBe(full.total);
    expect(compact.counts).toEqual(full.counts);
    expect(compact.policy).toEqual(full.policy);
    expect(compact.entries.map((view) => view.entry)).toEqual(
      full.entries.map((view) => view.entry),
    );
  });

  it("keeps the lifecycle field of each type and omits state for a type without one", () => {
    seed(
      1,
      () => ({ state: "open", title: "Ticket", description: "Body" }),
      "ticket",
    );
    entities.create(
      fixture.db,
      {
        id: "plain",
        type: "task",
        data: { status: "open", title: "Plain", extra: "x".repeat(500) },
        created_by: "test",
      },
      1,
      origin,
    );
    const ticket = inspect({ compact: true, task_id: "ticket-0" }).entries[0];
    expect(ticket.task?.data).toEqual({ state: "open", title: "Ticket" });
    // Unmanaged work cannot be enrolled, so its compact form is only reachable
    // through a legacy enrollment; the projection must still be safe.
    fixture.db
      .insert(schema.queueEntries)
      .values({
        id: "entry-plain",
        task_id: "plain",
        state: "queued",
        enqueue_order: 1_000,
        required_capabilities: [],
        retry_policy: {
          retry_safe: false,
          max_attempts: 3,
          initial_backoff_ms: 1,
          max_backoff_ms: 1,
        },
        available_at: 0,
        created_at: 0,
        updated_at: 0,
      })
      .run();
    const plain = inspect({ compact: true, task_id: "plain" }).entries[0];
    expect(plain.task?.data).toEqual({ title: "Plain" });
  });

  it("omits absent fields rather than inventing them", () => {
    seed(1, () => ({ phase: "todo" }));
    expect(inspect({ compact: true }).entries[0].task?.data).toEqual({
      phase: "todo",
    });
  });

  it("is at least 5x smaller on a 100-task fixture sized like the observed queue", () => {
    // About 5 KB of content per task (see managedWork), which puts the full
    // response near the ~575 KB the issue observed for 100 tasks.
    seed(100, (index) => managedWork(index));
    const full = inspect({ limit: 100 });
    const compact = inspect({ limit: 100, compact: true });
    expect(full.entries).toHaveLength(100);
    expect(compact.entries).toHaveLength(100);
    expect(jsonBytes(full)).toBeGreaterThan(500_000);
    expect(jsonBytes(full)).toBeLessThan(650_000);
    expect(jsonBytes(full) / jsonBytes(compact)).toBeGreaterThanOrEqual(5);
  });

  it("costs the same whatever the task content weighs, so the saving scales with it", () => {
    // Compact removes task data, not the entry, attempt or block reasons. Each
    // compact entry is about 0.6 KB, so thin tasks (about 1-2 KB of content)
    // fall short of 5x; only the full listing grows with the body. The separate
    // test above covers the 100-task fixture, so this comparison needs fewer.
    const sizes = [1_000, 2_000, 5_000];
    const measured = sizes.map((bodyBytes) => {
      fixture.rawDb.close();
      fixture = createTestDb();
      applySchema(fixture.db, compactDefinition, "test");
      seed(40, (index) => managedWork(index, bodyBytes));
      return {
        full: jsonBytes(inspect({ limit: 100 })),
        compact: jsonBytes(inspect({ limit: 100, compact: true })),
      };
    });
    expect(new Set(measured.map((size) => size.compact)).size).toBe(1);
    expect(measured[0].full).toBeLessThan(measured[1].full);
    expect(measured[1].full).toBeLessThan(measured[2].full);
    const ratio = (size: (typeof measured)[number]) => size.full / size.compact;
    expect(ratio(measured[0])).toBeLessThan(5);
    expect(ratio(measured[2])).toBeGreaterThanOrEqual(5);
  }, 20_000);

  it("never discloses more to a restricted caller than the full listing does", () => {
    seed(6, (index) => ({
      phase: "todo",
      title: `Work ${index}`,
      description: prose(index, 300),
    }));
    // Make issue-5 wait on a hidden predecessor: the block reason must keep
    // hiding it in the compact view exactly as it does in the full one.
    fixture.db
      .insert(schema.entityRelationships)
      .values({
        from_id: "issue-0",
        to_id: "issue-5",
        type: "blocks",
        created_at: 1,
        schema_version: 1,
      })
      .run();
    const visible = new Set(["issue-1", "issue-3", "issue-5"]);
    const allows = (id: string) => visible.has(id);
    const full = inspect({}, allows);
    const compact = inspect({ compact: true }, allows);
    expect(compact.total).toBe(3);
    expect(compact.counts).toEqual(full.counts);
    expect(compact.entries.map((view) => view.entry.task_id)).toEqual(
      full.entries.map((view) => view.entry.task_id),
    );
    expect(compact.entries.map((view) => view.block_reasons)).toEqual(
      full.entries.map((view) => view.block_reasons),
    );
    expect(JSON.stringify(compact)).not.toContain("issue-0");
    expect(JSON.stringify(compact)).not.toContain("issue-2");
    for (const [position, view] of compact.entries.entries()) {
      const fullData = full.entries[position].task?.data ?? {};
      for (const [field, value] of Object.entries(view.task?.data ?? {}))
        expect(fullData[field]).toEqual(value);
    }
  });

  it("round-trips through the response schema without anything stripped", () => {
    seed(4, (index) => ({
      phase: "todo",
      title: `Work ${index}`,
      description: prose(index, 300),
    }));
    const compact = inspect({ compact: true });
    // A strict consumer sees exactly the declared shape: parsing neither
    // rejects nor drops a field, unlike the full view whose task carries
    // stored metadata beyond {id, type, data}.
    expect(QueueInspectionSchema.parse(compact)).toEqual(compact);
    const full = inspect();
    expect(QueueInspectionSchema.parse(full).entries[0].task).toEqual({
      id: "issue-0",
      type: "issue",
      data: full.entries[0].task?.data,
    });
  });

  it("filters by type and state exactly as the full listing does", () => {
    seed(3, (index) => ({
      phase: index === 0 ? "aborted" : "todo",
      title: "t",
    }));
    for (const query of [
      { state: "backlog" as const },
      { type: "issue" },
      { type: "ticket" },
      { limit: 1, offset: 1 },
    ]) {
      const full: QueueInspection = inspect(query);
      const compact = inspect({ ...query, compact: true });
      expect(compact.entries.map((view) => view.entry.id)).toEqual(
        full.entries.map((view) => view.entry.id),
      );
      expect(compact.total).toBe(full.total);
    }
  });
});

describe("compact query schema", () => {
  it("defaults to false and accepts only booleans", () => {
    expect(QueueListQuerySchema.parse({}).compact).toBe(false);
    expect(QueueListQuerySchema.parse({ compact: true }).compact).toBe(true);
    expect(QueueListQuerySchema.parse({ compact: false }).compact).toBe(false);
    for (const value of ["true", "false", "1", 1, 0, "", null])
      expect(QueueListQuerySchema.safeParse({ compact: value }).success).toBe(
        false,
      );
  });
});
