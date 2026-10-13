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
  const filtered = queue.inspect(db, { task_id: "t259" });
  expect(filtered.total).toBe(1);
  expect(filtered.entries[0].entry.task_id).toBe("t259");
  expect(queue.inspect(db, { task_id: "t259" }, () => false).total).toBe(0);
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

it("filters entries whose starting or running attempt is past its lease", () => {
  const { db } = fixture;
  enable();
  const now = Date.now();
  const ids = [
    "reserved",
    "starting",
    "running",
    "renewed",
    "suspended",
    "hidden",
    "waiting",
  ];
  for (const [i, id] of ids.entries()) {
    task(id);
    // Priorities make the claim order follow `ids`.
    queue.enroll(
      db,
      { ...key(), task_id: id, priority: ids.length - i },
      origin,
      now,
    );
  }
  const granted = new Map<string, ReturnType<typeof attempts.get>>();
  for (const id of ids.slice(0, -1)) {
    const grant = queue.claimNext(db, key(), origin, undefined, now);
    if (grant.kind !== "granted") throw new Error(`grant ${id}`);
    expect(grant.entry.task_id).toBe(id);
    granted.set(id, grant.attempt);
  }
  const attempt = (id: string) => {
    const found = granted.get(id);
    if (!found) throw new Error(`attempt ${id}`);
    return found;
  };
  const accept = (id: string) =>
    granted.set(
      id,
      attempts.accept(db, attempt(id).id, authority(attempt(id)), origin, now)
        .attempt,
    );
  const start = (id: string) =>
    granted.set(
      id,
      attempts.started(
        db,
        attempt(id).id,
        {
          ...authority(attempt(id)),
          session: { provider: "fixture", id },
        },
        origin,
        now,
      ).attempt,
    );
  for (const id of ["starting", "running", "renewed", "suspended", "hidden"])
    accept(id);
  for (const id of ["running", "renewed", "suspended", "hidden"]) start(id);
  // A heartbeat moves the lease past the inspection time.
  attempts.heartbeat(
    db,
    attempt("renewed").id,
    authority(attempt("renewed")),
    origin,
    now + 30_000,
  );
  // Confirmed suspension clears the lease; keep one to prove the state check.
  db.update(schema.workAttempts)
    .set({ state: "suspended" })
    .where(eq(schema.workAttempts.id, attempt("suspended").id))
    .run();
  expect(
    ["reserved", "starting", "running", "suspended"].map(
      (id) => attempts.get(db, attempt(id).id).lease_expires_at,
    ),
  ).toEqual(Array(4).fill(now + 60_000));
  expect(attempts.get(db, attempt("reserved").id).state).toBe("reserved");

  // The lease boundary is inclusive.
  const lapsed = now + 60_000;
  const tasks = (inspection: ReturnType<typeof queue.inspect>) =>
    inspection.entries.map((view) => view.entry.task_id).sort();
  const expired = queue.inspect(db, { lease: "expired" }, undefined, lapsed);
  expect(tasks(expired)).toEqual(["hidden", "running", "starting"]);
  expect(expired.total).toBe(3);
  for (const view of expired.entries)
    expect(["starting", "running"]).toContain(view.attempt?.state);
  expect(expired.diagnostics?.expired_execution_leases).toBe(3);

  const paged = queue.inspect(
    db,
    { lease: "expired", limit: 1, offset: 1 },
    undefined,
    lapsed,
  );
  expect(paged.total).toBe(3);
  expect(paged.entries).toHaveLength(1);

  const scoped = queue.inspect(
    db,
    { lease: "expired" },
    (id) => id !== "hidden",
    lapsed,
  );
  expect(tasks(scoped)).toEqual(["running", "starting"]);
  expect(scoped.total).toBe(2);

  expect(
    queue.inspect(db, { lease: "expired" }, undefined, lapsed - 1).total,
  ).toBe(0);
  expect(queue.inspect(db, {}, undefined, lapsed).total).toBe(ids.length);
});

it("records the assigner and keeps ambiguous enrollment retries to one logical assignment", () => {
  const { db } = fixture;
  task("assigned");
  const orchestrator = { ...origin, principalId: "orchestrator" };
  const command = { ...key(), task_id: "assigned", target_principal: "worker" };
  const entry = queue.enroll(db, command, orchestrator);
  expect(entry).toMatchObject({
    enrolled_by_principal: "orchestrator",
    enrolled_by_participant: origin.participantId,
    target_principal: "worker",
  });
  // Exact replay returns the same assignment.
  expect(queue.enroll(db, command, orchestrator)).toEqual(entry);
  // A retry under a new key after an ambiguous failure names the existing entry.
  expect(() =>
    queue.enroll(db, { ...command, ...key() }, orchestrator),
  ).toThrow(`Task already has unfinished enrollment ${entry.id}`);
  expect(
    db
      .select()
      .from(schema.queueEntries)
      .where(eq(schema.queueEntries.task_id, "assigned"))
      .all(),
  ).toHaveLength(1);
});

it("lets only the assigner or a maintainer edit or withdraw recorded enrollments", () => {
  const { db } = fixture;
  task("owned");
  const orchestrator = { ...origin, principalId: "orchestrator" };
  const stranger = { ...origin, principalId: "stranger" };
  let entry = queue.enroll(db, { ...key(), task_id: "owned" }, orchestrator);
  const edit = () => ({
    ...key(),
    expected_revision: entry.revision,
    priority: 7,
  });
  expect(() => queue.edit(db, entry.id, edit(), stranger)).toThrow(
    "enrolled this work",
  );
  expect(() =>
    queue.withdraw(
      db,
      entry.id,
      { ...key(), expected_revision: entry.revision },
      stranger,
    ),
  ).toThrow("enrolled this work");
  entry = queue.edit(db, entry.id, edit(), orchestrator);
  expect(entry.priority).toBe(7);
  entry = queue.edit(db, entry.id, edit(), stranger, true);
  expect(
    queue.withdraw(
      db,
      entry.id,
      { ...key(), expected_revision: entry.revision },
      orchestrator,
    ).state,
  ).toBe("withdrawn");
});
