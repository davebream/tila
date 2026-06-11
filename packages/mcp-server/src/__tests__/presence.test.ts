import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPresenceTools } from "../tools/presence";
import {
  type MockFacade,
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
  findToolHandler,
} from "./helpers/mock-facade";

const PROJECT_ID = "test-project";

describe("registerPresenceTools", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerPresenceTools(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exactly 1 tool named tila_presence_heartbeat", () => {
    expect(server.tool).toHaveBeenCalledTimes(1);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual(["tila_presence_heartbeat"]);
  });

  it("does not include a machine property in the input schema", () => {
    const inputSchema = server.tool.mock.calls[0][2] as Record<string, unknown>;
    expect(inputSchema).not.toHaveProperty("machine");
    expect(inputSchema).toHaveProperty("info");
  });

  const findHandler = (name: string) => findToolHandler(server, name);

  describe("tila_presence_heartbeat", () => {
    it("calls presence.heartbeat with machine 'mcp-agent' and info", async () => {
      facade.presence.heartbeat.mockResolvedValue({
        ok: true,
        machine: "mcp-agent",
      });

      const handler = findHandler("tila_presence_heartbeat");
      const result = await handler({ info: { task: "coding" } });

      expect(facade.presence.heartbeat).toHaveBeenCalledWith("mcp-agent", {
        task: "coding",
      });
      expect(result.content[0].text).toContain('"ok":true');
    });

    it("calls presence.heartbeat with empty info when info is empty", async () => {
      facade.presence.heartbeat.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_presence_heartbeat");
      await handler({ info: {} });

      expect(facade.presence.heartbeat).toHaveBeenCalledWith("mcp-agent", {});
    });
  });

  describe("error handling", () => {
    it("wraps errors via toMcpError", async () => {
      facade.presence.heartbeat.mockRejectedValue(new Error("network error"));

      const handler = findHandler("tila_presence_heartbeat");
      await expect(handler({ info: {} })).rejects.toThrow("network error");
    });
  });

  describe("response formatting", () => {
    it("returns JSON-stringified response in text content array", async () => {
      const responseData = {
        ok: true,
        machine: "mcp-agent",
        lastSeen: "2026-05-25T12:00:00Z",
      };
      facade.presence.heartbeat.mockResolvedValue(responseData);

      const handler = findHandler("tila_presence_heartbeat");
      const result = await handler({ info: {} });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(responseData);
    });
  });
});
