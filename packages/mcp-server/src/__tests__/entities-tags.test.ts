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

describe("registerEntityTools — tags", () => {
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

  const findHandler = (name: string) => findToolHandler(server, name);

  it("tila_task_create schema includes an optional tags field", () => {
    const createCall = server.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "tila_task_create",
    );
    if (!createCall) throw new Error("tila_task_create not found");
    const schema = createCall[2] as Record<string, { _def?: unknown }>;
    expect(schema).toHaveProperty("tags");
  });

  it("tila_task_create passes tags to tasks.create when provided", async () => {
    facade.tasks.create.mockResolvedValue({
      ok: true,
      entity: { id: "T-1", tags: ["team:eng"] },
    });

    const handler = findHandler("tila_task_create");
    const result = await handler({
      id: "T-1",
      type: "task",
      data: { title: "Build it" },
      tags: ["team:eng"],
    });

    expect(facade.tasks.create).toHaveBeenCalledWith(
      "T-1",
      "task",
      { title: "Build it" },
      ["team:eng"],
    );
    expect(result.content[0].text).toContain('"team:eng"');
  });

  it("tila_task_create passes undefined tags when not provided", async () => {
    facade.tasks.create.mockResolvedValue({
      ok: true,
      entity: { id: "T-2", tags: [] },
    });

    const handler = findHandler("tila_task_create");
    await handler({ id: "T-2", type: "task", data: {} });

    expect(facade.tasks.create).toHaveBeenCalledWith(
      "T-2",
      "task",
      {},
      undefined,
    );
  });

  it("tila_task_show response surfaces tags returned by the server", async () => {
    facade.tasks.get.mockResolvedValue({
      ok: true,
      entity: {
        id: "T-1",
        type: "task",
        data: {},
        tags: ["env:prod"],
        status: "open",
      },
      relationships: [],
    });

    const handler = findHandler("tila_task_show");
    const result = await handler({ id: "T-1" });
    expect(result.content[0].text).toContain('"env:prod"');
  });
});
