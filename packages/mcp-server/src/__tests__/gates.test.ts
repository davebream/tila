import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGateTools } from "../tools/gates";
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

describe("registerGateTools", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerGateTools(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers 3 tools with correct names", () => {
    expect(server.tool).toHaveBeenCalledTimes(3);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual([
      "tila_gate_create",
      "tila_gate_resolve",
      "tila_gate_cancel",
    ]);
  });

  describe("tila_gate_create", () => {
    it("calls gates.create with all required and optional fields", async () => {
      facade.gates.create.mockResolvedValue({
        ok: true,
        gate: { id: "gate-1", status: "pending" },
      });

      const handler = findToolHandler(server, "tila_gate_create");
      const result = await handler({
        resource: "T-1",
        await_type: "ci",
        fence: 42,
        timeout_at: 1700000000000,
        data: { run_url: "https://ci.example.com/123" },
      });

      expect(facade.gates.create).toHaveBeenCalledWith({
        resource: "T-1",
        await_type: "ci",
        fence: 42,
        timeout_at: 1700000000000,
        data: { run_url: "https://ci.example.com/123" },
      });
      expect(result.content[0].text).toContain('"ok":true');
      expect(result.content[0].text).toContain('"gate-1"');
    });

    it("calls gates.create with only required fields (timeout_at and data omitted)", async () => {
      facade.gates.create.mockResolvedValue({
        ok: true,
        gate: { id: "gate-2" },
      });

      const handler = findToolHandler(server, "tila_gate_create");
      await handler({
        resource: "T-2",
        await_type: "human",
        fence: 10,
      });

      expect(facade.gates.create).toHaveBeenCalledWith({
        resource: "T-2",
        await_type: "human",
        fence: 10,
        timeout_at: undefined,
        data: undefined,
      });
    });
  });

  describe("tila_gate_resolve", () => {
    it("calls gates.resolve with gate id and resolution", async () => {
      facade.gates.resolve.mockResolvedValue({ ok: true });

      const handler = findToolHandler(server, "tila_gate_resolve");
      const result = await handler({
        gate_id: "gate-1",
        resolution: "ci-passed",
      });

      expect(facade.gates.resolve).toHaveBeenCalledWith("gate-1", {
        resolution: "ci-passed",
      });
      expect(result.content[0].text).toContain('"ok":true');
    });

    it("calls gates.resolve with undefined resolution when omitted", async () => {
      facade.gates.resolve.mockResolvedValue({ ok: true });

      const handler = findToolHandler(server, "tila_gate_resolve");
      await handler({ gate_id: "gate-5" });

      expect(facade.gates.resolve).toHaveBeenCalledWith("gate-5", {
        resolution: undefined,
      });
    });
  });

  describe("tila_gate_cancel", () => {
    it("calls gates.remove with the gate id", async () => {
      facade.gates.remove.mockResolvedValue({ ok: true });

      const handler = findToolHandler(server, "tila_gate_cancel");
      const result = await handler({ gate_id: "gate-3" });

      expect(facade.gates.remove).toHaveBeenCalledWith("gate-3");
      expect(result.content[0].text).toContain('"ok":true');
    });
  });

  describe("error handling", () => {
    it("wraps errors via toMcpError for gate_create", async () => {
      facade.gates.create.mockRejectedValue(new Error("timeout"));

      const handler = findToolHandler(server, "tila_gate_create");
      await expect(
        handler({ resource: "T-1", await_type: "ci", fence: 1 }),
      ).rejects.toThrow("timeout");
    });

    it("wraps errors via toMcpError for gate_cancel", async () => {
      facade.gates.remove.mockRejectedValue(new Error("not found"));

      const handler = findToolHandler(server, "tila_gate_cancel");
      await expect(handler({ gate_id: "gate-999" })).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("response formatting", () => {
    it("returns JSON-stringified response in text content array", async () => {
      const responseData = {
        ok: true,
        gate: { id: "gate-7", status: "resolved" },
      };
      facade.gates.resolve.mockResolvedValue(responseData);

      const handler = findToolHandler(server, "tila_gate_resolve");
      const result = await handler({
        gate_id: "gate-7",
        resolution: "approved",
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(responseData);
    });
  });
});
