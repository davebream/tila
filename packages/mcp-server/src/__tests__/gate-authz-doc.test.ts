/**
 * Asserts that tila_gate_resolve and tila_gate_cancel descriptions carry a note
 * that only write permission is required (no fencing token / owner scoping).
 *
 * Decision §21 in docs/01-DECISIONS.md: resolve and cancel are guarded by
 * requirePermission("write"), not by fencing tokens. The MCP tool descriptions
 * must reflect this so that callers know they do NOT need to hold the claim.
 */

import { describe, expect, it } from "vitest";
import { registerGateTools } from "../tools/gates";
import {
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
} from "./helpers/mock-facade";

type ToolCall = [string, string, unknown, unknown];

function getToolCalls(server: MockServer): ToolCall[] {
  // server.tool is a vitest mock function; .mock.calls holds all invocation args
  const mock = server.tool as { mock: { calls: unknown[][] } };
  return mock.mock.calls as ToolCall[];
}

describe("gate authz documentation", () => {
  it("tila_gate_resolve description mentions write permission (no fencing token required)", () => {
    const server: MockServer = createMockServer();
    const facade = createMockFacade();
    registerGateTools(asServer(server), asFacade(facade), "test-project");

    const resolveCall = getToolCalls(server).find(
      (c) => c[0] === "tila_gate_resolve",
    );
    expect(resolveCall).toBeDefined();
    const description = resolveCall?.[1] ?? "";

    // Must mention that write permission suffices — callers do NOT need the fence.
    expect(description).toMatch(/write/i);
  });

  it("tila_gate_cancel description mentions write permission (no fencing token required)", () => {
    const server: MockServer = createMockServer();
    const facade = createMockFacade();
    registerGateTools(asServer(server), asFacade(facade), "test-project");

    const cancelCall = getToolCalls(server).find(
      (c) => c[0] === "tila_gate_cancel",
    );
    expect(cancelCall).toBeDefined();
    const description = cancelCall?.[1] ?? "";

    // Must mention that write permission suffices — callers do NOT need the fence.
    expect(description).toMatch(/write/i);
  });
});
