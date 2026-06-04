import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createPresenceMethods } from "../presence";

describe("createPresenceMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listAll() calls GET /projects/:id/presence/all", async () => {
    const responseBody = {
      ok: true,
      records: [
        {
          machine: "agent-1",
          active: true,
          last_seen: "2026-05-18T12:00:00Z",
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );

    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "t",
    });
    const presence = createPresenceMethods(client, "proj-1");
    const result = await presence.listAll();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test/projects/proj-1/presence/all");
    expect(result).toEqual(responseBody);
  });

  it("list() calls GET /projects/:id/presence", async () => {
    const responseBody = { ok: true, records: [] };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );

    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "t",
    });
    const presence = createPresenceMethods(client, "proj-1");
    const result = await presence.list();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test/projects/proj-1/presence");
    expect(result).toEqual(responseBody);
  });
});
