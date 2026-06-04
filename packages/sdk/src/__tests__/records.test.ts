import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createRecordMethods } from "../records";

function mockResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createRecordMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("create issues POST /projects/:id/records/:type with body", async () => {
    const responseBody = {
      ok: true,
      record: {
        type: "config",
        key: "main",
        value: { a: 1 },
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 1,
        tags: [],
      },
      fence: 1,
      revision: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    const result = await records.create("config", {
      key: "main",
      value: { a: 1 },
    });

    expect(result.ok).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/config");
    expect(url).not.toContain("main"); // key is in body, not URL
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.key).toBe("main");
    expect(body.value).toEqual({ a: 1 });
  });

  it("set with slash key issues PUT with per-segment encoding", async () => {
    const responseBody = {
      ok: true,
      record: {
        type: "pipeline_config",
        key: "env/prod/db",
        value: { host: "x" },
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 1,
        tags: [],
      },
      fence: 2,
      revision: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    await records.set("pipeline_config", "env/prod/db", {
      value: { host: "x" },
      fence: 1,
    });

    const [url, init] = mockFetch.mock.calls[0];
    // Each segment encoded individually: env/prod/db stays as env/prod/db
    // (none of these segments contain special chars, so they stay as-is)
    expect(url).toContain(
      "/projects/proj-1/records/pipeline_config/env/prod/db",
    );
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body);
    expect(body.fence).toBe(1);
    expect(body.value).toEqual({ host: "x" });
  });

  it("set encodes special characters within key segments", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, record: {}, fence: 1, revision: 1 }, 200),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    await records.set("config", "a b/c&d", {
      value: { x: 1 },
      fence: 1,
    });

    const [url] = mockFetch.mock.calls[0];
    // "a b" -> "a%20b", "c&d" -> "c%26d", joined with literal /
    expect(url).toContain("/records/config/a%20b/c%26d");
  });

  it("get issues GET /projects/:id/records/:type/:key", async () => {
    const responseBody = {
      ok: true,
      record: {
        type: "config",
        key: "main",
        value: { a: 1 },
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 1,
        tags: [],
      },
      fence: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    const result = await records.get("config", "main");

    expect(result.ok).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/config/main");
    expect(init.method).toBe("GET");
  });

  it("patch issues PATCH /projects/:id/records/:type/:key", async () => {
    const responseBody = {
      ok: true,
      record: {
        type: "config",
        key: "main",
        value: { a: 2 },
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 2,
        tags: [],
      },
      fence: 2,
      revision: 2,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    await records.patch("config", "main", {
      patch: { a: 2 },
      fence: 1,
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/config/main");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body.patch).toEqual({ a: 2 });
    expect(body.fence).toBe(1);
  });

  it("archive issues POST to ~/archive/:key action route", async () => {
    const responseBody = {
      ok: true,
      record: {
        type: "config",
        key: "main",
        value: { a: 1 },
        status: "archived",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 2,
        tags: [],
      },
      fence: 2,
      revision: 2,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    await records.archive("config", "main", { fence: 1 });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/config/~/archive/main");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.fence).toBe(1);
  });

  it("unarchive issues POST to ~/unarchive/:key action route", async () => {
    const responseBody = {
      ok: true,
      record: {
        type: "config",
        key: "main",
        value: { a: 1 },
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 3,
        tags: [],
      },
      fence: 3,
      revision: 3,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    await records.unarchive("config", "main", { fence: 2 });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/config/~/unarchive/main");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.fence).toBe(2);
  });

  it("history issues GET to ~/history/:key with query params", async () => {
    const responseBody = {
      ok: true,
      items: [],
      meta: { total: 0, limit: 10, next_cursor: null },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    await records.history("config", "main", { limit: 10, values: true });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/config/~/history/main");
    expect(url).toContain("limit=10");
    expect(url).toContain("values=true");
    expect(init.method).toBe("GET");
  });

  it("list issues GET /projects/:id/records/:type with query params", async () => {
    const responseBody = {
      ok: true,
      items: [],
      meta: { total: 0, limit: 200, next_cursor: null },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    await records.list("config", { tag: "stable", filter: '{"env":"prod"}' });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/config");
    expect(url).toContain("tag=stable");
    expect(url).toContain("filter=");
    expect(init.method).toBe("GET");
  });

  it("types issues GET /projects/:id/records/_types", async () => {
    const responseBody = {
      ok: true,
      types: ["config", "secret_ref"],
      declared_types: ["config"],
      in_use_types: ["config", "secret_ref"],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    const result = await records.types();

    expect(result.ok).toBe(true);
    expect(result.types).toEqual(["config", "secret_ref"]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/_types");
    expect(init.method).toBe("GET");
  });

  it("typesInUse extracts in_use_types from _types response", async () => {
    const responseBody = {
      ok: true,
      types: ["config", "secret_ref"],
      declared_types: ["config"],
      in_use_types: ["secret_ref"],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    const result = await records.typesInUse();

    expect(result.ok).toBe(true);
    // typesInUse returns ONLY the in_use_types, not the merged list
    expect(result.types).toEqual(["secret_ref"]);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/records/_types");
  });

  it("typesInUse returns empty array when in_use_types is absent", async () => {
    const responseBody = {
      ok: true,
      types: ["config"],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody, 200));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    const result = await records.typesInUse();

    expect(result.ok).toBe(true);
    expect(result.types).toEqual([]);
  });
});
