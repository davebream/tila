import {
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
  CreateRoomSchema,
  PublishMessageSchema,
  type RuntimeIdentity,
} from "@tila/schemas";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as bindings from "../../ops-sqlite/src/agent-binding-ops";
import * as ops from "../../ops-sqlite/src/conversation-ops";
import { signConversationCursor } from "../src/routes/conversation-cursor";
import { createConversationRoutes } from "../src/routes/conversation-routes";
import type { RouterDeps } from "../src/routes/types";
import { createTestDb } from "./helpers/create-test-db";
let f: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createConversationRoutes>;
let acting: ops.ConversationAuthority;
const owner = {
  principal_id: "owner",
  participant_id: "operator",
  can_manage: true,
  runtime: null,
};
const secret = "fixture-cursor-key";
const headers = (a = acting) => ({
  "X-Tila-Conversation-Authority": JSON.stringify(a),
  "X-Tila-Conversation-Cursor-Key": secret,
  "Content-Type": "application/json",
});
beforeEach(() => {
  f = createTestDb({ foreignKeys: "on" });
  const runtime: RuntimeIdentity = {
    run_id: crypto.randomUUID(),
    agent_id: "worker",
    run_role: "acting",
    principal_id: "owner",
    participant_id: "session",
    enrollment_id: crypto.randomUUID(),
    workload_binding_id: null,
    lease_expires_at: Math.floor(Date.now() / 1000) + 300,
  };
  acting = { ...owner, runtime, can_manage: false };
  bindings.register(
    f.db,
    AgentRegistrationSchema.parse({ id: "worker", name: "Worker" }),
    owner,
  );
  bindings.attach(
    f.db,
    "worker",
    AttachAgentBindingSchema.parse({
      expected_epoch: 0,
      harness: "test",
      capability_report: {
        protocol: 1,
        adapter_version: "fixture",
        capabilities: {},
      },
    }),
    acting,
  );
  ops.createRoom(
    f.db,
    CreateRoomSchema.parse({ id: "general", name: "General" }),
    owner,
  );
  ops.setMember(f.db, "general", "agent:worker", true, owner);
  app = createConversationRoutes({ db: f.db } as unknown as RouterDeps);
});
afterEach(() => f.sqlite.close());
it("requires a trusted envelope on every conversation route", async () => {
  for (const path of ["/rooms", "/inbox/worker", "/dispatch/worker/status"])
    expect((await app.request(path)).status).toBe(403);
});
it("returns pending deliveries even when an inbox pagination cursor expired", async () => {
  await ops.publish(
    f.db,
    "general",
    PublishMessageSchema.parse({ client_op_id: "one", body: "pending" }),
    owner,
  );
  const scope = JSON.stringify([
    "inbox",
    "worker",
    acting.principal_id,
    acting.runtime?.run_id,
    "1",
  ]);
  const cursor = await signConversationCursor(
    secret,
    scope,
    ops.cursorGeneration(f.db),
    { ordinal: 999, id: crypto.randomUUID() },
    Date.now() - 259200001,
  );
  const response = await app.request(
    `/inbox/worker?cursor=${encodeURIComponent(cursor)}`,
    { headers: headers() },
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    cursor_error: string;
    pending: number;
    deliveries: unknown[];
  };
  expect(result.cursor_error).toBe("cursor-expired");
  expect(result.pending).toBe(1);
  expect(result.deliveries).toHaveLength(1);
});
it("limits long polls to two waiters and wakes registered waiters on publication", async () => {
  const version = ops.inboxVersion(f.db, "worker", acting).version;
  const path = `/inbox/worker/watch?version=${encodeURIComponent(version)}&timeout_ms=1000`;
  const first = app.request(path, { headers: headers() });
  const second = app.request(path, { headers: headers() });
  // Let Hono reach the synchronous waiter registration before the third request.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await app.request(path, { headers: headers() })).status).toBe(429);
  const sent = await app.request("/rooms/general/messages", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ client_op_id: "wake", body: "wake" }),
  });
  expect(sent.status).toBe(200);
  for (const response of await Promise.all([first, second]))
    expect(await response.json()).toMatchObject({ changed: true, pending: 1 });
  const fresh = ops.inboxVersion(f.db, "worker", acting).version;
  const timeout = await app.request(
    `/inbox/worker/watch?version=${encodeURIComponent(fresh)}&timeout_ms=0`,
    { headers: headers() },
  );
  expect(await timeout.json()).toMatchObject({ ok: true, changed: false });
});

it("separates backward history from forward tail cursors across publication and authorization", async () => {
  const publish = async (body: string) =>
    ops.publish(
      f.db,
      "general",
      PublishMessageSchema.parse({ client_op_id: crypto.randomUUID(), body }),
      owner,
    );
  for (const body of ["one", "two", "three"]) await publish(body);
  const get = async (query: string, a = owner) =>
    app.request(`/rooms/general/messages?${query}`, { headers: headers(a) });
  const initial = (await (await get("direction=backward&limit=2")).json()) as {
    messages: { body: string }[];
    cursor: string;
    tail_cursor: string;
    has_more: boolean;
  };
  expect(initial.messages.map((row) => row.body)).toEqual(["two", "three"]);
  expect(initial.has_more).toBe(true);
  await publish("four");
  const older = (await (
    await get(
      `direction=backward&limit=2&cursor=${encodeURIComponent(initial.cursor)}`,
    )
  ).json()) as typeof initial;
  expect(older.messages.map((row) => row.body)).toEqual(["one"]);
  const tail = (await (
    await get(`cursor=${encodeURIComponent(initial.tail_cursor)}`)
  ).json()) as typeof initial;
  expect(tail.messages.map((row) => row.body)).toEqual(["four"]);
  expect(
    (await get(`cursor=${encodeURIComponent(initial.cursor)}`)).status,
  ).toBe(400);
  expect(
    (
      await get(
        `direction=backward&cursor=${encodeURIComponent(initial.cursor)}`,
        { ...owner, principal_id: "other", can_manage: false },
      )
    ).status,
  ).toBe(400);
  expect((await get("direction=invalid")).status).toBe(400);
});
