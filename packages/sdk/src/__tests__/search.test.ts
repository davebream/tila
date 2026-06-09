import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createSearchMethods } from "../search";

function mockResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createSearchMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("search issues GET /projects/:id/search with q", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, results: [], total: 0 }),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const search = createSearchMethods(client, "proj-1");

    await search.search("my query");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/projects/proj-1/search");
    expect(url).toContain("q=my+query");
    expect(init.method).toBe("GET");
  });

  it("search sends tag_filter query param when tagFilter provided", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, results: [], total: 0 }),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const search = createSearchMethods(client, "proj-1");

    await search.search("my query", { tagFilter: ["repo:a", "team:x"] });

    const [url] = mockFetch.mock.calls[0];
    expect(decodeURIComponent(url)).toContain("tag_filter=repo:a,team:x");
  });

  it("search omits tag_filter when tagFilter is not provided", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, results: [], total: 0 }),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const search = createSearchMethods(client, "proj-1");

    await search.search("my query");

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain("tag_filter");
  });

  it("search omits tag_filter when tagFilter is empty array", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, results: [], total: 0 }),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const search = createSearchMethods(client, "proj-1");

    await search.search("my query", { tagFilter: [] });

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain("tag_filter");
  });
});
