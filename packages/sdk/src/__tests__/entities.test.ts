import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createTaskMethods } from "../entities";
import { TILA_ERRORS } from "../error-codes";
import { TilaApiError } from "../errors";
import { withRetry } from "../retry";

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
  it("serializes attention filters without losing page metadata", async () => {
    const page = {
      ok: true,
      entities: [],
      total: 18,
      limit: 2,
      offset: 0,
      has_more: true,
      next_cursor: "next",
      scope: { restricted: true, outcome_types: ["issue"] },
    };
    mockFetch.mockResolvedValueOnce(ok(page));
    expect(
      await tasks().list({
        blocked: true,
        outcome: ["failure", "abandoned"],
        limit: "2",
        cursor: "previous",
      }),
    ).toEqual(page);
    const query = new URL(mockFetch.mock.calls[0][0]).searchParams;
    expect(query.get("blocked")).toBe("1");
    expect(query.get("outcome")).toBe("failure,abandoned");
    expect(query.get("cursor")).toBe("previous");
    mockFetch.mockResolvedValueOnce(ok(page));
    await tasks().list({ blocked: false });
    expect(
      new URL(mockFetch.mock.calls[1][0]).searchParams.has("blocked"),
    ).toBe(false);
  });

  it("rejects invalid and empty outcome lists before sending HTTP", async () => {
    for (const outcome of [[], ["failed"], ["failure", ""]])
      await expect(
        tasks().list({ outcome: outcome as never }),
      ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

/**
 * Two input errors the Worker used to answer as a retryable 500: task data past
 * the size bound and a relationship to a task that does not exist. Each now
 * arrives as a typed, non-retryable error, so a retrying caller stops at once.
 */
describe("createTaskMethods — refusals are not retried", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function refusal(status: number, code: string, message: string) {
    return new Response(
      JSON.stringify({ ok: false, error: { code, message, retryable: false } }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  function tasks() {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    return createTaskMethods(client, "proj-1");
  }

  it("surfaces an oversized create as payload-too-large and does not retry", async () => {
    mockFetch.mockResolvedValue(
      refusal(413, "payload-too-large", "Task data is 300000 bytes"),
    );

    const error = await withRetry(
      () => tasks().create("T-1", "task", { description: "x" }),
      { baseDelayMs: 0, jitter: false },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TilaApiError);
    expect(error).toMatchObject({
      code: TILA_ERRORS.PAYLOAD_TOO_LARGE,
      status: 413,
      retryable: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces a relationship to a missing task as not-found and does not retry", async () => {
    mockFetch.mockResolvedValue(
      refusal(404, "not-found", "Entity T-missing not found"),
    );

    const error = await withRetry(
      () => tasks().addRelationship("T-1", "T-missing", "blocks"),
      { baseDelayMs: 0, jitter: false },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TilaApiError);
    expect(error).toMatchObject({
      code: TILA_ERRORS.NOT_FOUND,
      status: 404,
      retryable: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
