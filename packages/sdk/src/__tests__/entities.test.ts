import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createTaskMethods } from "../entities";

/**
 * Path/params/body guards for the task HTTP methods that must line up with the
 * Worker routes (the "wrong path/params" bug class fixed in Task 12). Mock-fetch
 * asserts the OUTGOING request shape so a future change cannot silently re-break
 * the SDK→Worker contract.
 */
describe("createTaskMethods — outgoing request shape", () => {
  const mockFetch = vi.fn();
  const BASE = "https://api.test/projects/proj-1/tasks";

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function tasks() {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    return createTaskMethods(client, "proj-1");
  }

  it("addRelationship() POSTs /tasks/relationships with { from_id, to_id, type }", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, created: true }));

    await tasks().addRelationship("A", "B", "blocks");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/relationships`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      from_id: "A",
      to_id: "B",
      type: "blocks",
    });
  });

  it("listRelationships() GETs /tasks/relationships with from_id/to_id/type query params", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, relationships: [] }));

    await tasks().listRelationships({
      fromId: "A",
      toId: "B",
      type: "blocks",
    });

    const [url, init] = mockFetch.mock.calls[0];
    const u = new URL(url);
    expect(u.pathname).toBe("/projects/proj-1/tasks/relationships");
    expect(init.method ?? "GET").toBe("GET");
    expect(u.searchParams.get("from_id")).toBe("A");
    expect(u.searchParams.get("to_id")).toBe("B");
    expect(u.searchParams.get("type")).toBe("blocks");
  });

  it("listRelationships() omits unset filter params", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, relationships: [] }));

    await tasks().listRelationships({ fromId: "A" });

    const [url] = mockFetch.mock.calls[0];
    const u = new URL(url);
    expect(u.searchParams.get("from_id")).toBe("A");
    expect(u.searchParams.has("to_id")).toBe(false);
    expect(u.searchParams.has("type")).toBe(false);
  });

  it("ready() GETs /tasks/ready with type/parent/limit/include-soft-blocked", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, entities: [] }));

    await tasks().ready({
      type: "task",
      parent: "E-1",
      limit: 25,
      includeSoftBlocked: true,
    });

    const [url, init] = mockFetch.mock.calls[0];
    const u = new URL(url);
    expect(u.pathname).toBe("/projects/proj-1/tasks/ready");
    expect(init.method ?? "GET").toBe("GET");
    expect(u.searchParams.get("type")).toBe("task");
    expect(u.searchParams.get("parent")).toBe("E-1");
    expect(u.searchParams.get("limit")).toBe("25");
    expect(u.searchParams.get("include-soft-blocked")).toBe("true");
  });

  it("ready() omits include-soft-blocked when false/unset", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, entities: [] }));

    await tasks().ready({ type: "task" });

    const [url] = mockFetch.mock.calls[0];
    const u = new URL(url);
    expect(u.searchParams.get("type")).toBe("task");
    expect(u.searchParams.has("include-soft-blocked")).toBe(false);
  });

  it("list({ compact: true }) sends compact=true; omits it otherwise", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, entities: [] }));
    await tasks().list({ compact: true });
    let [url] = mockFetch.mock.calls[0];
    expect(new URL(url).searchParams.get("compact")).toBe("true");

    mockFetch.mockResolvedValueOnce(ok({ ok: true, entities: [] }));
    await tasks().list({ type: "task" });
    [url] = mockFetch.mock.calls[1];
    expect(new URL(url).searchParams.has("compact")).toBe(false);
  });
});
