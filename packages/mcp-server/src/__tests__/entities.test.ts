import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEntityTools } from "../tools/entities";
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

describe("registerEntityTools", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerEntityTools(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers 8 tools with correct names", () => {
    expect(server.tool).toHaveBeenCalledTimes(8);

    const toolNames = server.tool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toEqual([
      "tila_task_create",
      "tila_task_list",
      "tila_task_show",
      "tila_task_update",
      "tila_task_ready",
      "tila_task_archive",
      "tila_task_relationships_add",
      "tila_task_relationships_list",
    ]);
  });

  const findHandler = (name: string) => findToolHandler(server, name);

  describe("tila_task_create", () => {
    it("calls tasks.create with id, type, data, and tags", async () => {
      facade.tasks.create.mockResolvedValue({
        ok: true,
        entity: { id: "T-1" },
      });

      const handler = findHandler("tila_task_create");
      const result = await handler({
        id: "T-1",
        type: "task",
        data: { title: "Build it" },
      });

      expect(facade.tasks.create).toHaveBeenCalledWith(
        "T-1",
        "task",
        { title: "Build it" },
        undefined,
      );
      expect(result.content[0].text).toContain('"ok":true');
    });

    it("forwards tags when provided", async () => {
      facade.tasks.create.mockResolvedValue({
        ok: true,
        entity: { id: "T-2" },
      });

      const handler = findHandler("tila_task_create");
      await handler({
        id: "T-2",
        type: "task",
        data: {},
        tags: ["team:eng"],
      });

      expect(facade.tasks.create).toHaveBeenCalledWith("T-2", "task", {}, [
        "team:eng",
      ]);
    });
  });

  describe("tila_task_list", () => {
    it("calls tasks.list with compact mode and optional filters", async () => {
      facade.tasks.list.mockResolvedValue({ ok: true, entities: [] });

      const handler = findHandler("tila_task_list");
      await handler({ type: "task", status: "open" });

      expect(facade.tasks.list).toHaveBeenCalledWith({
        type: "task",
        status: "open",
        compact: true,
      });
    });

    it("passes undefined for omitted optional filters", async () => {
      facade.tasks.list.mockResolvedValue({ ok: true, entities: [] });

      const handler = findHandler("tila_task_list");
      await handler({});

      expect(facade.tasks.list).toHaveBeenCalledWith({
        type: undefined,
        status: undefined,
        compact: true,
      });
    });

    it("forwards tag_filter as tagFilter when provided", async () => {
      facade.tasks.list.mockResolvedValue({ ok: true, entities: [] });

      const handler = findHandler("tila_task_list");
      await handler({ tag_filter: ["repo:a", "team:x"] });

      expect(facade.tasks.list).toHaveBeenCalledWith(
        expect.objectContaining({ tagFilter: ["repo:a", "team:x"] }),
      );
    });

    it("omits tagFilter when tag_filter is not provided", async () => {
      facade.tasks.list.mockResolvedValue({ ok: true, entities: [] });

      const handler = findHandler("tila_task_list");
      await handler({});

      const callArg = facade.tasks.list.mock.calls[0][0];
      expect(callArg).not.toHaveProperty("tagFilter");
    });
  });

  describe("tila_task_show", () => {
    it("calls tasks.get with the id", async () => {
      facade.tasks.get.mockResolvedValue({
        ok: true,
        entity: { id: "T-1" },
        relationships: [],
      });

      const handler = findHandler("tila_task_show");
      const result = await handler({ id: "T-1" });

      expect(facade.tasks.get).toHaveBeenCalledWith("T-1");
      expect(result.content[0].text).toContain('"T-1"');
    });
  });

  describe("tila_task_update", () => {
    it("calls tasks.update with id, data, and fence", async () => {
      facade.tasks.update.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_task_update");
      await handler({ id: "T-1", data: { status: "done" }, fence: 42 });

      expect(facade.tasks.update).toHaveBeenCalledWith(
        "T-1",
        { status: "done" },
        42,
      );
    });
  });

  describe("tila_task_ready", () => {
    it("calls tasks.ready with optional type filter", async () => {
      facade.tasks.ready.mockResolvedValue({ ok: true, entities: [] });

      const handler = findHandler("tila_task_ready");
      await handler({ type: "task" });

      expect(facade.tasks.ready).toHaveBeenCalledWith({ type: "task" });
    });

    it("slices entities to limit and adds truncated+total when over limit", async () => {
      const entities = Array.from({ length: 60 }, (_, i) => ({ id: `T-${i}` }));
      facade.tasks.ready.mockResolvedValue({ ok: true, entities });

      const handler = findHandler("tila_task_ready");
      const result = await handler({ limit: 50 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entities).toHaveLength(50);
      expect(parsed.truncated).toBe(true);
      expect(parsed.total).toBe(60);
    });

    it("returns result unchanged when under limit (no truncated key)", async () => {
      const entities = Array.from({ length: 10 }, (_, i) => ({ id: `T-${i}` }));
      facade.tasks.ready.mockResolvedValue({ ok: true, entities });

      const handler = findHandler("tila_task_ready");
      const result = await handler({ limit: 50 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entities).toHaveLength(10);
      expect(parsed).not.toHaveProperty("truncated");
      expect(parsed).not.toHaveProperty("total");
    });
  });

  describe("tila_task_archive", () => {
    it("calls tasks.archive with id and fence", async () => {
      facade.tasks.archive.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_task_archive");
      await handler({ id: "T-1", fence: 10 });

      expect(facade.tasks.archive).toHaveBeenCalledWith("T-1", 10);
    });
  });

  describe("tila_task_relationships_add", () => {
    it("calls tasks.addRelationship with from, to, and type", async () => {
      facade.tasks.addRelationship.mockResolvedValue({ ok: true });

      const handler = findHandler("tila_task_relationships_add");
      await handler({ from_id: "T-1", to_id: "T-2", type: "blocks" });

      expect(facade.tasks.addRelationship).toHaveBeenCalledWith(
        "T-1",
        "T-2",
        "blocks",
      );
    });
  });

  describe("tila_task_relationships_list", () => {
    it("calls tasks.listRelationships filtered by fromId", async () => {
      facade.tasks.listRelationships.mockResolvedValue({
        ok: true,
        relationships: [],
      });

      const handler = findHandler("tila_task_relationships_list");
      await handler({ id: "T-1" });

      expect(facade.tasks.listRelationships).toHaveBeenCalledWith({
        fromId: "T-1",
      });
    });

    it("slices relationships to limit and adds truncated+total when over limit", async () => {
      const relationships = Array.from({ length: 75 }, (_, i) => ({
        from_id: `T-${i}`,
        to_id: "T-X",
        type: "blocks",
      }));
      facade.tasks.listRelationships.mockResolvedValue({
        ok: true,
        relationships,
      });

      const handler = findHandler("tila_task_relationships_list");
      const result = await handler({ id: "T-1", limit: 50 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.relationships).toHaveLength(50);
      expect(parsed.truncated).toBe(true);
      expect(parsed.total).toBe(75);
    });

    it("returns result unchanged when under limit (no truncated key)", async () => {
      const relationships = Array.from({ length: 5 }, (_, i) => ({
        from_id: `T-${i}`,
        to_id: "T-X",
        type: "blocks",
      }));
      facade.tasks.listRelationships.mockResolvedValue({
        ok: true,
        relationships,
      });

      const handler = findHandler("tila_task_relationships_list");
      const result = await handler({ id: "T-1", limit: 50 });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.relationships).toHaveLength(5);
      expect(parsed).not.toHaveProperty("truncated");
      expect(parsed).not.toHaveProperty("total");
    });
  });

  describe("error handling", () => {
    it("wraps errors via toMcpError", async () => {
      facade.tasks.create.mockRejectedValue(new Error("network failure"));

      const handler = findHandler("tila_task_create");
      await expect(
        handler({ id: "T-1", type: "task", data: {} }),
      ).rejects.toThrow("network failure");
    });
  });

  describe("tila_task_list — no limit param (CRUD tools excluded)", () => {
    it("tila_task_list has no limit key in its input schema", () => {
      const listCall = server.tool.mock.calls.find(
        (c: unknown[]) => c[0] === "tila_task_list",
      );
      if (!listCall) throw new Error("tila_task_list not found");
      const schema = listCall[2] as Record<string, unknown>;
      expect(schema).not.toHaveProperty("limit");
    });

    it("tila_task_show has no limit key in its input schema", () => {
      const showCall = server.tool.mock.calls.find(
        (c: unknown[]) => c[0] === "tila_task_show",
      );
      if (!showCall) throw new Error("tila_task_show not found");
      const schema = showCall[2] as Record<string, unknown>;
      expect(schema).not.toHaveProperty("limit");
    });
  });

  describe("tila_task_list tag_filter grammar", () => {
    it("accepts tag_filter with invalid grammar (permissive — validation is worker's job)", () => {
      const { z } = require("zod");
      const listCall = server.tool.mock.calls.find(
        (c: unknown[]) => c[0] === "tila_task_list",
      );
      if (!listCall) throw new Error("tila_task_list not found");
      const schema = listCall[2] as Record<string, import("zod").ZodTypeAny>;
      const result = z.object(schema).safeParse({ tag_filter: ["bad tag!"] });
      expect(result.success).toBe(true);
    });
  });
});
