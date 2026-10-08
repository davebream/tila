import { describe, expect, it } from "vitest";
import {
  SendSignalRequestSchema,
  SignalSchema,
  SignalTargetSchema,
} from "../src/signal";

describe("participant-scoped signal schemas", () => {
  it.each([
    {
      type: "participant",
      principal_id: "principal-a",
      participant_id: "participant-a",
    },
    { type: "principal", principal_id: "principal-a" },
    { type: "group", group_id: "reviewers" },
    { type: "broadcast" },
  ])("accepts the $type target", (target) => {
    expect(SignalTargetSchema.parse(target)).toEqual(target);
  });

  it("rejects legacy string targets at the public request boundary", () => {
    expect(
      SendSignalRequestSchema.safeParse({
        target: "display-name",
        kind: "info",
      }).success,
    ).toBe(false);
  });

  it("requires structured sender, delivery, and acknowledger identities", () => {
    const identity = {
      principal_id: "principal-a",
      participant_id: "participant-a",
      display_name: "Alice",
      environment: { client_name: "cli", machine: "mac-a" },
    };
    const parsed = SignalSchema.parse({
      id: "sig-1",
      target: { type: "broadcast" },
      kind: "ready",
      payload: {},
      sender: identity,
      created_at: 1,
      expires_at: 2,
      deliveries: [
        {
          recipient: identity,
          acknowledged_at: 1,
          acknowledged_by: identity,
        },
      ],
    });
    expect(parsed.sender.principal_id).toBe("principal-a");
    expect(parsed.deliveries[0].acknowledged_by).toEqual(identity);
  });
});
