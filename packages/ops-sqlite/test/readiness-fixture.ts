import { entityOps, schema, schemaOps } from "@tila/ops-sqlite";
import { eq } from "drizzle-orm";

export const lifecycleDefinition = `schema_version = 1
[work_units.issue.fields.phase]
type = "enum"
required = true
values = ["todo", "working", "shipped", "aborted"]
[work_units.issue.lifecycle]
field = "phase"
dispatchable = ["todo"]
terminal = ["shipped", "aborted"]
dependency_satisfied = ["shipped"]
on_start = "working"
[work_units.issue.lifecycle.outcomes]
success = "shipped"
failure = "todo"
cancelled = "aborted"
[work_units.task.fields.status]
type = "string"
`;

export const readinessOrigin = {
  principalId: "test",
  participantId: "worker",
  environment: {},
  actor: "test",
};
export function seedReadinessFixture(
  db: Parameters<typeof entityOps.create>[0],
) {
  schemaOps.applySchema(db, lifecycleDefinition, "test");
  for (const [id, phase] of Object.entries({
    success: "shipped",
    cancelled: "aborted",
    archived: "todo",
    "archived-success": "shipped",
    ready: "todo",
    waiting: "todo",
    blocked: "todo",
    "archived-dependent": "todo",
    "completed-archive-dependent": "todo",
    soft: "todo",
    "cycle-a": "todo",
    "cycle-b": "todo",
    missing: "todo",
    absent: "todo",
    gated: "todo",
    "expired-gate": "todo",
  }))
    entityOps.create(
      db,
      { id, type: "issue", data: { phase }, created_by: "test" },
      1,
      readinessOrigin,
    );
  entityOps.create(
    db,
    {
      id: "legacy-open",
      type: "task",
      data: { status: "open" },
      created_by: "test",
    },
    1,
    readinessOrigin,
  );
  for (const id of ["archived", "archived-success", "absent"])
    db.update(schema.entities)
      .set({ archived: 1 })
      .where(eq(schema.entities.id, id))
      .run();
  for (const [from_id, to_id, type] of [
    ["success", "waiting", "blocks"],
    ["cancelled", "blocked", "blocks"],
    ["archived", "archived-dependent", "blocks"],
    ["archived-success", "completed-archive-dependent", "blocks"],
    ["ready", "soft", "soft-blocks"],
    ["cycle-a", "cycle-b", "blocks"],
    ["cycle-b", "cycle-a", "blocks"],
    ["absent", "missing", "blocks"],
  ])
    db.insert(schema.entityRelationships)
      .values({ from_id, to_id, type, created_at: 1, schema_version: 1 })
      .run();
  for (const [id, resource, timeout_at] of [
    ["gate-1", "issue:gated", null],
    ["gate-2", "expired-gate", 1],
  ] as const) {
    db.insert(schema.gates)
      .values({
        id,
        resource,
        timeout_at,
        await_type: "human",
        fence: 1,
        created_at: 1,
        created_by: "test",
      })
      .run();
  }
}

export const expectedReadyIds = [
  "completed-archive-dependent",
  "expired-gate",
  "legacy-open",
  "ready",
  "waiting",
];
