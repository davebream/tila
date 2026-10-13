import { beforeEach, describe, expect, it } from "vitest";
import { recoveryFor } from "../tool-registration";
import { registerAgentTools } from "../tools/agents";
import { registerConversationTools } from "../tools/conversations";
import {
  type MockFacade,
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
  findToolHandler,
} from "./helpers/mock-facade";

const agent = {
  id: "worker",
  name: "Builder",
  owner_principal_id: "owner",
  bind_policy: [],
  binding_epoch: 2,
  archived: false,
  revision: 8,
  profile_selection: null,
  created_at: 1,
  updated_at: 2,
};

describe("agent and room management tools", () => {
  let server: MockServer;
  let facade: MockFacade;
  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerAgentTools(asServer(server), asFacade(facade), "project");
    registerConversationTools(asServer(server), asFacade(facade), "project");
  });

  it("passes the reviewed revision and retry key through to the SDK", async () => {
    facade.agents.update.mockResolvedValue({ ok: true, agent });
    await findToolHandler(
      server,
      "tila_agent_update",
    )({
      agent: "worker",
      expected_revision: 7,
      name: "Builder",
      idempotency_key: "retry-1",
    });
    expect(facade.agents.update).toHaveBeenCalledWith(
      "worker",
      { expected_revision: 7, name: "Builder" },
      { idempotencyKey: "retry-1" },
    );
    facade.agents.archive.mockResolvedValue({
      ok: true,
      agent: { ...agent, archived: true },
      released: null,
      pending_deliveries: 0,
    });
    await findToolHandler(
      server,
      "tila_agent_archive",
    )({
      agent: "worker",
      expected_revision: 8,
      expected_epoch: 2,
    });
    expect(facade.agents.archive).toHaveBeenCalledWith(
      "worker",
      { expected_revision: 8, expected_epoch: 2 },
      { idempotencyKey: undefined },
    );
  });

  it("changes room membership against a revision", async () => {
    facade.conversations.join.mockResolvedValue({ ok: true });
    await findToolHandler(
      server,
      "tila_room_member_set",
    )({
      room: "general",
      member: "principal:reader",
      wake: false,
      expected_revision: 3,
    });
    expect(facade.conversations.join).toHaveBeenCalledWith(
      "general",
      "principal:reader",
      false,
      { expectedRevision: 3, idempotencyKey: undefined },
    );
  });

  it("tells callers to re-read after a revision conflict", () => {
    const recovery = recoveryFor(
      Object.assign(new Error("agent:worker changed"), {
        code: "revision-conflict",
        status: 412,
      }),
    );
    expect(recovery).toMatchObject({
      code: "revision-conflict",
      retry_safety: "after_recovery",
    });
    expect(recovery.recovery_action).toMatch(/Read the resource again/);
  });
});
