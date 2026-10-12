import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as attempts from "../src/attempt-ops";
import * as coord from "../src/coordination-ops";
import * as entities from "../src/entity-ops";
import * as queue from "../src/queue-ops";
import * as schema from "../src/schema";
import { applySchema } from "../src/schema-ops";
import { authority, attemptOrigin as origin } from "./attempt-fixture";
import { type TestDb, createTestDb, testOrigin } from "./helpers";
import { lifecycleDefinition } from "./readiness-fixture";

let fixture: TestDb;
beforeEach(() => {
  fixture = createTestDb();
  applySchema(fixture.db, lifecycleDefinition, "test");
});
afterEach(() => fixture.rawDb.close());
function task(id: string, phase = "todo") {
  entities.create(
    fixture.db,
    { id, type: "issue", data: { phase }, created_by: "test" },
    1,
    origin,
  );
}
function enable(execution_limit = 20, wip_limit: number | null = null) {
  return queue.configure(
    fixture.db,
    {
      expected_revision: queue.policy(fixture.db).revision,
      idempotency_key: crypto.randomUUID(),
      enabled: true,
      paused: false,
      execution_limit,
      wip_limit,
    },
    origin,
    true,
  );
}
const key = () => ({ idempotency_key: crypto.randomUUID() });

it("requires explicit activation and finite execution capacity, and scopes policy revision receipts", () => {
  const { db } = fixture;
  expect(queue.claimNext(db, key(), origin)).toMatchObject({
    kind: "no_grant",
    reason: "disabled",
  });
  expect(() =>
    queue.configure(
      db,
      { ...key(), expected_revision: 0, enabled: true },
      origin,
      true,
    ),
  ).toThrow("positive execution limit");
  expect(() =>
    queue.configure(
      db,
      { ...key(), expected_revision: 0, execution_limit: 1 },
      origin,
      false,
    ),
  ).toThrow("Maintainer");
  const input = {
    ...key(),
    expected_revision: 0,
    enabled: true,
    paused: false,
    execution_limit: 2,
  };
  const first = queue.configure(db, input, origin, true);
  expect(queue.configure(db, input, origin, true)).toEqual(first);
  expect(() =>
    queue.configure(db, { ...input, ...key() }, origin, true),
  ).toThrow("Expected revision");
  expect(queue.claimNext(db, key(), origin)).toMatchObject({
    kind: "no_grant",
    reason: "empty",
  });
});

it("skips incompatible and blocked priorities, then orders priority before enrollment time", () => {
  const { db } = fixture;
  enable();
  for (const id of [
    "blocked",
    "special",
    "target",
    "low",
    "high",
    "same-priority",
  ])
    task(id, id === "blocked" ? "aborted" : "todo");
  queue.enroll(db, { ...key(), task_id: "blocked", priority: 100 }, origin);
  queue.enroll(
    db,
    {
      ...key(),
      task_id: "special",
      priority: 90,
      required_capabilities: ["mac"],
    },
    origin,
  );
  queue.enroll(
    db,
    { ...key(), task_id: "target", priority: 80, target_principal: "other" },
    origin,
  );
  for (const [id, priority] of [
    ["low", 0],
    ["high", 5],
    ["same-priority", 5],
  ] as const)
    queue.enroll(db, { ...key(), task_id: id, priority }, origin);
  const next = () => queue.claimNext(db, key(), origin);
  const first = next();
  const second = next();
  const third = next();
  expect(
    [first, second, third].map((r) => r.kind === "granted" && r.entry.task_id),
  ).toEqual(["high", "same-priority", "low"]);
  expect(next()).toMatchObject({ kind: "no_grant", reason: "blocked" });
  expect(
    queue.claimNext(db, { ...key(), capabilities: ["mac"] }, origin),
  ).toMatchObject({ kind: "granted", entry: { task_id: "special" } });
});

it("admits at most 20 of 100 concurrent consumers and replays one reservation per command", async () => {
  const { db } = fixture;
  enable();
  for (let i = 0; i < 100; i++) {
    task(`t${i}`);
    queue.enroll(db, { ...key(), task_id: `t${i}` }, origin);
  }
  const commands = Array.from({ length: 100 }, (_, i) => ({
    input: key(),
    owner: testOrigin(`worker-${i}`),
  }));
  const results = await Promise.all(
    commands.map(async ({ input, owner }) => queue.claimNext(db, input, owner)),
  );
  expect(results.filter((result) => result.kind === "granted")).toHaveLength(
    20,
  );
  expect(queue.occupancy(db)).toEqual({ execution: 20, wip: 20 });
  commands.forEach(({ input, owner }, i) =>
    expect(queue.claimNext(db, input, owner)).toEqual(results[i]),
  );
  expect(db.select().from(schema.workAttempts).all()).toHaveLength(20);
  expect(
    db
      .select()
      .from(schema.queueOperationReceipts)
      .all()
      .filter((r) => r.attempt_id),
  ).toHaveLength(20);
}, 30_000);

it("keeps existing grants when paused or lowered, and checks WIP independently", () => {
  const { db } = fixture;
  enable(3, 1);
  for (const id of ["one", "two"]) {
    task(id);
    queue.enroll(db, { ...key(), task_id: id }, origin);
  }
  const grant = queue.claimNext(db, key(), origin);
  if (grant.kind !== "granted") throw new Error("grant");
  expect(queue.claimNext(db, key(), origin)).toMatchObject({
    reason: "wip_capacity",
  });
  queue.configure(
    db,
    { ...key(), expected_revision: 1, paused: true, execution_limit: 1 },
    origin,
    true,
  );
  expect(queue.claimNext(db, key(), origin)).toMatchObject({
    reason: "paused",
  });
  const accepted = attempts.accept(
    db,
    grant.attempt.id,
    authority(grant.attempt),
    origin,
  );
  expect(accepted.grant_valid).toBe(true);
  queue.configure(
    db,
    { ...key(), expected_revision: 2, paused: false, wip_limit: null },
    origin,
    true,
  );
  expect(queue.claimNext(db, key(), origin)).toMatchObject({
    reason: "execution_capacity",
  });
});

it("never returns an unauthorized task even on a grant replay", () => {
  const { db } = fixture;
  enable();
  for (const id of ["private", "allowed"]) {
    task(id);
    queue.enroll(db, { ...key(), task_id: id }, origin);
  }
  const input = key();
  const grant = queue.claimNext(db, input, origin, (id) => id === "allowed");
  expect(grant).toMatchObject({
    kind: "granted",
    entry: { task_id: "allowed" },
  });
  expect(() => queue.claimNext(db, input, origin, () => false)).toThrow(
    "Current resource permissions",
  );
  expect(
    queue
      .inspect(db, {}, (id) => id === "allowed")
      .entries.map((v) => v.entry.task_id),
  ).toEqual(["allowed"]);
});

it("prevents generic claim/lifecycle/archive bypass and permits content editing", () => {
  const { db } = fixture;
  enable();
  task("task");
  const entry = queue.enroll(db, { ...key(), task_id: "task" }, origin);
  expect(() => coord.acquire(db, "task", origin, "exclusive", 60_000)).toThrow(
    "Managed task claims",
  );
  expect(
    entities.update(db, "task", { title: "editable" }, 0, origin).data.title,
  ).toBe("editable");
  expect(() =>
    entities.update(db, "task", { phase: "shipped" }, 0, origin),
  ).toThrow("Lifecycle changes");
  const grant = queue.claimNext(db, key(), origin);
  if (grant.kind !== "granted") throw new Error("grant");
  let attempt = attempts.accept(
    db,
    grant.attempt.id,
    authority(grant.attempt),
    origin,
  ).attempt;
  expect(() =>
    coord.renew(db, "issue:task", origin, attempt.fence, 60_000),
  ).toThrow("Managed task claims");
  expect(() => coord.release(db, "task", attempt.fence, origin)).toThrow(
    "Managed task claims",
  );
  expect(() => entities.archive(db, "task", attempt.fence, origin)).toThrow(
    "before archiving",
  );
  expect(() =>
    entities.update(db, "task", { phase: "shipped" }, attempt.fence, origin),
  ).toThrow("terminal status");
  expect(
    entities.update(db, "task", { phase: "todo" }, attempt.fence, origin).data
      .phase,
  ).toBe("todo");
  attempt = attempts.finish(
    db,
    attempt.id,
    {
      ...authority(attempt),
      outcome: {
        status: "success",
        execution_stopped: true,
        evidence: [],
        unresolved_external_execution: false,
      },
    },
    origin,
  ).attempt;
  expect(attempt.state).toBe("terminal");
  expect(queue.getEntry(db, entry.id).state).toBe("finished");
});

it("requires revision-aware configuration after activation, including after disabling", () => {
  const { db } = fixture;
  enable();
  queue.configure(
    db,
    { ...key(), expected_revision: 1, enabled: false },
    origin,
    true,
  );
  expect(() => applySchema(db, lifecycleDefinition, "old-client")).toThrow(
    "schema-revision-required",
  );
  expect(
    applySchema(db, lifecycleDefinition, "new-client", undefined, origin, {
      expected_revision: 1,
    }),
  ).toMatchObject({ reason: "no-change" });
});

it("lists more than 250 entries and protects enrollment edits and withdrawal with revisions", () => {
  const { db } = fixture;
  for (let i = 0; i < 260; i++) {
    task(`t${i}`);
    queue.enroll(db, { ...key(), task_id: `t${i}` }, origin);
  }
  const page = queue.inspect(db, { limit: 100, offset: 200 });
  expect(page.total).toBe(260);
  expect(page.entries).toHaveLength(60);
  const entry = page.entries[0].entry;
  queue.edit(
    db,
    entry.id,
    { ...key(), expected_revision: entry.revision, priority: 100 },
    origin,
  );
  expect(() =>
    queue.withdraw(
      db,
      entry.id,
      { ...key(), expected_revision: entry.revision },
      origin,
    ),
  ).toThrow("Expected revision");
  expect(
    queue.withdraw(
      db,
      entry.id,
      { ...key(), expected_revision: entry.revision + 1 },
      origin,
    ).state,
  ).toBe("withdrawn");
}, 30_000);

it("recomputes expired grant validity without starting replacement work on replay", () => {
  const { db } = fixture;
  enable();
  task("task");
  queue.enroll(db, { ...key(), task_id: "task" }, origin);
  const now = Date.now();
  const input = key();
  const grant = queue.claimNext(db, input, origin, undefined, now);
  if (grant.kind !== "granted") throw new Error("grant");
  const replay = queue.claimNext(db, input, origin, undefined, now + 60_000);
  expect(replay).toMatchObject({
    kind: "granted",
    grant_valid: false,
    attempt: { state: "terminal" },
  });
  expect(queue.occupancy(db)).toEqual({ execution: 0, wip: 0 });
  expect(db.select().from(schema.workAttempts).all()).toHaveLength(1);
  expect(
    queue.claimNext(db, key(), origin, undefined, now + 60_000),
  ).toMatchObject({ kind: "granted", grant_valid: true });
});

it("does not replay a legacy configuration success after managed revision checks become mandatory", () => {
  const { db } = fixture;
  const options = { idempotency_key: "legacy" };
  applySchema(db, lifecycleDefinition, "legacy", undefined, origin, options);
  enable();
  expect(() =>
    applySchema(db, lifecycleDefinition, "legacy", undefined, origin, options),
  ).toThrow("schema-revision-required");
});
