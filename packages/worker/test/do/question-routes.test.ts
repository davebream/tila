import { CredentialPolicySchema } from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  correlation,
  prepare,
} from "../../../ops-sqlite/test/question-contract";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import { createQuestionRoutes } from "../../src/do/routes/question-routes";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

let fixture: TestDb;
let app: Hono;
beforeEach(() => {
  fixture = createTestDb();
  app = new Hono();
  installProjectErrorHandlers(app);
  app.route(
    "/",
    createQuestionRoutes({
      db: fixture.db as RouterDeps["db"],
      ctx: {} as DurableObjectState,
      enrichOpts: vi.fn(),
    }),
  );
});
afterEach(() => fixture.sqlite.close());
function send(
  action: string,
  command: unknown,
  id?: string,
  policy?: unknown,
  overrides = {},
) {
  return app.request(`/questions/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(policy ? { "X-Tila-Credential-Policy": JSON.stringify(policy) } : {}),
    },
    body: JSON.stringify({
      principal_id: "orchestrator",
      participant_id: "orchestrator-process",
      environment: {},
      authorized_role: "participant",
      runtime: null,
      command,
      id,
      ...overrides,
    }),
  });
}
it("checks capability restrictions before receipt replay and filters pending reads", async () => {
  const { q } = prepare(fixture.db);
  const command = { ...correlation(q), text: "yes" };
  expect((await send("answer", command, q.id)).status).toBe(200);
  const readOnly = CredentialPolicySchema.parse({
    role: "participant",
    capabilities: ["tasks:read"],
  });
  expect((await send("answer", command, q.id, readOnly)).status).toBe(403);
  const restricted = CredentialPolicySchema.parse({
    role: "participant",
    capabilities: ["tasks:read", "tasks:write"],
    restrictions: { task_types: ["other"] },
  });
  expect((await send("get", {}, q.id, restricted)).status).toBe(403);
  expect(
    await (await send("list", {}, undefined, restricted)).json(),
  ).toMatchObject({ result: { questions: [], total: 0 } });
  const permitted = { ...restricted, restrictions: { task_types: ["issue"] } };
  expect(
    await (await send("list", { limit: 1 }, undefined, permitted)).json(),
  ).toMatchObject({
    result: { questions: [{ question: { id: q.id } }], total: 1 },
  });
});
it("rejects missing routing authorization and non-owner escalation answers", async () => {
  const { command, q } = prepare(fixture.db);
  expect(
    (
      await send(
        "ask",
        { ...command, id: crypto.randomUUID(), idempotency_key: "another" },
        undefined,
        undefined,
        { principal_id: "worker", participant_id: "worker-process" },
      )
    ).status,
  ).toBe(403);
  const escalated = await send(
    "escalate",
    {
      ...correlation(q),
      responder_principal_id: "owner",
      reason: "owner needed",
    },
    q.id,
    undefined,
    { target_authorized: true },
  );
  expect(escalated.status).toBe(200);
  const {
    result: { question },
  } = await escalated.json();
  expect(
    (
      await send(
        "answer",
        { ...correlation(question), text: "yes" },
        q.id,
        undefined,
        { principal_id: "owner" },
      )
    ).status,
  ).toBe(403);
});
it("rejects relay and replaced runtime sessions even on receipt replay", async () => {
  const { q } = prepare(fixture.db);
  const command = { ...correlation(q), text: "yes" };
  expect((await send("answer", command, q.id)).status).toBe(200);
  const runtime = {
    run_id: crypto.randomUUID(),
    agent_id: "missing-agent",
    run_role: "relay",
    principal_id: "orchestrator",
    participant_id: "orchestrator-process",
    enrollment_id: null,
    workload_binding_id: null,
    lease_expires_at: 1,
  };
  expect(
    (await send("answer", command, q.id, undefined, { runtime })).status,
  ).toBe(403);
});
