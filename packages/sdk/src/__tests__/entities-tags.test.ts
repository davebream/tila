import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createTaskMethods } from "../entities";

function mockResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("entity create with tags (SDK)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes tags in the request body when provided", async () => {
    const responseBody = {
      ok: true,
      entity: {
        id: "T-1",
        type: "task",
        data: { title: "Build tags" },
        tags: ["team:eng", "env:prod"],
        status: "open",
        created_at: 1000,
        updated_at: 1000,
        fence: 1,
      },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = createTaskMethods(client, "proj-1");

    await tasks.create("T-1", "task", { title: "Build tags" }, [
      "team:eng",
      "env:prod",
    ]);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.tags).toEqual(["team:eng", "env:prod"]);
  });

  it("omits tags from the request body when not provided", async () => {
    const responseBody = {
      ok: true,
      entity: {
        id: "T-2",
        type: "task",
        data: {},
        tags: [],
        status: "open",
        created_at: 1000,
        updated_at: 1000,
        fence: 1,
      },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = createTaskMethods(client, "proj-1");

    await tasks.create("T-2", "task");

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.tags).toBeUndefined();
  });

  // NOTE: read-side coverage is intentionally mock-confirms-mock — fetch is mocked to return a
  // body that already contains `tags`, so this asserts SDK pass-through, not a real read
  // round-trip. The real server→client tag round-trip is covered at the ops/integration layer
  // (packages/backend-do/test, integration-tests). Request-side assertions below are authoritative.
  it("get response surfaces tags from the server", async () => {
    const responseBody = {
      ok: true,
      entity: {
        id: "T-1",
        type: "task",
        data: {},
        tags: ["team:platform"],
        status: "open",
        created_at: 1000,
        updated_at: 1000,
        fence: 2,
      },
      relationships: [],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = createTaskMethods(client, "proj-1");

    const result = await tasks.get("T-1");
    expect((result as Record<string, unknown>).entity).toMatchObject({
      tags: ["team:platform"],
    });
  });

  it("list response surfaces tags from the server", async () => {
    const responseBody = {
      ok: true,
      entities: [
        {
          id: "T-1",
          type: "task",
          data: {},
          tags: ["env:staging"],
          status: "open",
          created_at: 1000,
          updated_at: 1000,
          fence: 1,
        },
      ],
      total: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = createTaskMethods(client, "proj-1");

    const result = await tasks.list();
    const entities = (result as Record<string, unknown>).entities as Array<
      Record<string, unknown>
    >;
    expect(entities[0].tags).toEqual(["env:staging"]);
  });

  it("list sends tag_filter query param when tagFilter provided", async () => {
    const responseBody = { ok: true, entities: [], total: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = createTaskMethods(client, "proj-1");

    await tasks.list({ tagFilter: ["repo:a", "team:x"] });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("tag_filter=repo%3Aa%2Cteam%3Ax");
  });

  it("list omits tag_filter when tagFilter is not provided", async () => {
    const responseBody = { ok: true, entities: [], total: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = createTaskMethods(client, "proj-1");

    await tasks.list({});

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain("tag_filter");
  });

  it("list omits tag_filter when tagFilter is empty array", async () => {
    const responseBody = { ok: true, entities: [], total: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = createTaskMethods(client, "proj-1");

    await tasks.list({ tagFilter: [] });

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain("tag_filter");
  });
});
