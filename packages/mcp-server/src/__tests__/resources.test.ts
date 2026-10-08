import { describe, expect, it } from "vitest";
import { registerAllResources } from "../resources/index";
import {
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
} from "./helpers/mock-facade";

type ResourceHandler = (
  uri: { href: string },
  variables?: Record<string, string>,
) => Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}>;

const PROJECT_ID = "test-project";

describe("registerAllResources — project-presence", () => {
  it("calls presence.listAll (the /presence/all-backed method)", async () => {
    const server = createMockServer();
    const facade = createMockFacade();

    // Non-fatal: schema fetch returns nothing (no record resources registered)
    facade.schema.get.mockResolvedValue({ ok: true, schema: null });

    await registerAllResources(asServer(server), asFacade(facade), PROJECT_ID);

    const presenceCall = server.resource.mock.calls.find(
      (c: unknown[]) => c[0] === "project-presence",
    );
    expect(presenceCall).toBeDefined();
    if (!presenceCall)
      throw new Error("project-presence resource not registered");
    const handler = presenceCall[presenceCall.length - 1] as ResourceHandler;

    const allParticipantsResponse = {
      ok: true,
      participants: [
        {
          principal_id: "token:one",
          participant_id: "participant-1",
          environment: { machine: "agent-1" },
          last_seen: 1000,
          info: {},
          active: true,
        },
        {
          principal_id: "token:two",
          participant_id: "participant-2",
          environment: { machine: "agent-2" },
          last_seen: 500,
          info: {},
          active: false,
        },
      ],
    };
    facade.presence.listAll.mockResolvedValue(allParticipantsResponse);

    const result = await handler({ href: "tila://project/presence" });

    expect(facade.presence.listAll).toHaveBeenCalled();

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.participants).toHaveLength(2);
    expect(parsed.participants[0].active).toBe(true);
    expect(parsed.participants[1].active).toBe(false);
    expect(parsed.participants[0].environment.machine).toBe("agent-1");
    expect(parsed.participants[1].environment.machine).toBe("agent-2");
  });

  it("passes through mixed active:true and active:false flags unchanged", async () => {
    const server = createMockServer();
    const facade = createMockFacade();

    facade.schema.get.mockResolvedValue({ ok: true, schema: null });

    await registerAllResources(asServer(server), asFacade(facade), PROJECT_ID);

    const presenceCall2 = server.resource.mock.calls.find(
      (c: unknown[]) => c[0] === "project-presence",
    );
    if (!presenceCall2)
      throw new Error("project-presence resource not registered");
    const handler = presenceCall2[presenceCall2.length - 1] as ResourceHandler;

    const allInactiveResponse = {
      ok: true,
      participants: [
        {
          principal_id: "token:old",
          participant_id: "participant-old",
          environment: { machine: "old-agent" },
          last_seen: 1,
          info: {},
          active: false,
        },
      ],
    };
    facade.presence.listAll.mockResolvedValue(allInactiveResponse);

    const result = await handler({ href: "tila://project/presence" });
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.participants[0].active).toBe(false);
  });
});
