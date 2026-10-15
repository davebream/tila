import { entityOps, queueOps, schemaOps } from "@tila/ops-sqlite";
import {
  CredentialPolicySchema,
  type QueueInspection,
  QueueInspectionSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import { createQueueRoutes } from "../../src/do/routes/queue-routes";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

const definition = `schema_version = 1
[work_units.issue.fields.phase]
type = "enum"
values = ["todo", "done"]
[work_units.issue.fields.title]
type = "string"
[work_units.issue.fields.description]
type = "text"
[work_units.issue.lifecycle]
field = "phase"
dispatchable = ["todo"]
terminal = ["done"]
dependency_satisfied = ["done"]
[work_units.ticket.fields.state]
type = "enum"
values = ["open", "done"]
[work_units.ticket.fields.title]
type = "string"
[work_units.ticket.fields.description]
type = "text"
[work_units.ticket.lifecycle]
field = "state"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]
`;
const origin = {
  principalId: "worker",
  participantId: "worker-process",
  environment: {},
  actor: "worker",
};
const body = "Body of the work item. ".repeat(80);

let fixture: TestDb;
let app: Hono;
beforeEach(() => {
  // Ages and diagnostic windows read the wall clock; freeze it so two
  // inspections of the same state serialize identically.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_800_000_000_000);
  fixture = createTestDb();
  const db = fixture.db as RouterDeps["db"];
  schemaOps.applySchema(db, definition, "test");
  queueOps.configure(
    db,
    {
      idempotency_key: "enable",
      expected_revision: 0,
      enabled: true,
      paused: false,
      execution_limit: 5,
    },
    origin,
    true,
  );
  for (const [id, type, data] of [
    [
      "issue-a",
      "issue",
      { phase: "todo", title: "Issue A", description: body },
    ],
    [
      "ticket-a",
      "ticket",
      { state: "open", title: "Ticket A", description: body },
    ],
    [
      "ticket-b",
      "ticket",
      { state: "open", title: "Ticket B", description: body },
    ],
  ] as const) {
    entityOps.create(db, { id, type, data, created_by: "test" }, 1, origin);
    queueOps.enroll(db, { idempotency_key: id, task_id: id }, origin);
  }
  app = new Hono();
  installProjectErrorHandlers(app);
  app.route(
    "/",
    createQueueRoutes({
      db,
      ctx: {} as DurableObjectState,
      enrichOpts: vi.fn(),
    }),
  );
});
afterEach(() => {
  fixture.sqlite.close();
  vi.useRealTimers();
});

function inspect(command: unknown, policy?: unknown) {
  return app.request("/queue/inspect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(policy ? { "X-Tila-Credential-Policy": JSON.stringify(policy) } : {}),
    },
    body: JSON.stringify({
      principal_id: "reader",
      participant_id: "queue-read-only",
      environment: {},
      authorized_role: "viewer",
      command,
    }),
  });
}
async function result(response: Response) {
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: QueueInspection }).result;
}
const scoped = CredentialPolicySchema.parse({
  role: "participant",
  capabilities: ["tasks:read", "claims:read"],
  restrictions: { task_types: ["ticket"] },
});

describe("POST /queue/inspect compact", () => {
  it("returns the stored task unchanged when compact is absent or false", async () => {
    const absent = await (await inspect({})).text();
    const explicit = await (await inspect({ compact: false })).text();
    expect(explicit).toBe(absent);
    const view = (JSON.parse(absent) as { result: QueueInspection }).result;
    expect(view.entries).toHaveLength(3);
    expect(view.entries[0].task?.data).toMatchObject({ description: body });
  });

  it("narrows task data and nothing else", async () => {
    const full = await result(await inspect({}));
    const compact = await result(await inspect({ compact: true }));
    expect(compact.entries.map((view) => view.task)).toEqual([
      {
        id: "issue-a",
        type: "issue",
        data: { phase: "todo", title: "Issue A" },
      },
      {
        id: "ticket-a",
        type: "ticket",
        data: { state: "open", title: "Ticket A" },
      },
      {
        id: "ticket-b",
        type: "ticket",
        data: { state: "open", title: "Ticket B" },
      },
    ]);
    expect({
      ...compact,
      entries: compact.entries.map((v) => v.entry),
    }).toEqual({
      ...full,
      entries: full.entries.map((v) => v.entry),
    });
    expect(compact.entries.map((v) => v.attempt)).toEqual(
      full.entries.map((v) => v.attempt),
    );
    expect(compact.entries.map((v) => v.block_reasons)).toEqual(
      full.entries.map((v) => v.block_reasons),
    );
  });

  it("is still strictly parseable and much smaller", async () => {
    const full = await (await inspect({})).text();
    const compactText = await (await inspect({ compact: true })).text();
    const compact = JSON.parse(compactText).result;
    expect(QueueInspectionSchema.parse(compact)).toEqual(compact);
    expect(compactText.length).toBeLessThan(full.length / 2);
  });

  it("gives a task-type-restricted credential no more than the full listing", async () => {
    const full = await result(await inspect({}, scoped));
    const compact = await result(await inspect({ compact: true }, scoped));
    expect(full.total).toBe(2);
    expect(compact.total).toBe(2);
    expect(compact.counts).toEqual(full.counts);
    expect(compact.entries.map((v) => v.entry.task_id)).toEqual([
      "ticket-a",
      "ticket-b",
    ]);
    expect(JSON.stringify(compact)).not.toContain("issue-a");
    for (const [index, view] of compact.entries.entries()) {
      const stored = full.entries[index].task?.data ?? {};
      for (const [field, value] of Object.entries(view.task?.data ?? {}))
        expect(stored[field]).toEqual(value);
      expect(Object.keys(view.task?.data ?? {}).sort()).toEqual([
        "state",
        "title",
      ]);
    }
    // Unscoped work is out of reach by task filter too, not just by hiding rows.
    const only = await result(
      await inspect({ compact: true, task_id: "issue-a" }, scoped),
    );
    expect(only.total).toBe(0);
    expect(only.entries).toEqual([]);
  });

  it("rejects a non-boolean compact value rather than coercing it", async () => {
    for (const value of ["true", "false", 1, ""]) {
      const response = await inspect({ compact: value });
      expect(response.status, String(value)).toBe(400);
    }
  });

  it("still denies a credential without the read capabilities", async () => {
    const noClaims = CredentialPolicySchema.parse({
      role: "participant",
      capabilities: ["tasks:read"],
    });
    expect((await inspect({ compact: true }, noClaims)).status).toBe(403);
  });
});
