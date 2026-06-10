import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createJournalMethods } from "../journal";

describe("createJournalMethods — outgoing request shape", () => {
  const mockFetch = vi.fn();

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

  function journal() {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    return createJournalMethods(client, "proj-1");
  }

  it("query() GETs /projects/:id/journal with resource/kind/after_seq/limit", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, events: [] }));

    await journal().query({
      resource: "T-1",
      kind: "entity.update",
      after_seq: "10",
      limit: "20",
    });

    const [url, init] = mockFetch.mock.calls[0];
    const u = new URL(url);
    expect(u.pathname).toBe("/projects/proj-1/journal");
    expect(init.method ?? "GET").toBe("GET");
    expect(u.searchParams.get("resource")).toBe("T-1");
    expect(u.searchParams.get("kind")).toBe("entity.update");
    expect(u.searchParams.get("after_seq")).toBe("10");
    expect(u.searchParams.get("limit")).toBe("20");
    // The old, ignored param names must NOT be sent.
    expect(u.searchParams.has("entity_id")).toBe(false);
    expect(u.searchParams.has("event_kind")).toBe(false);
  });

  it("query() omits unset params", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true, events: [] }));

    await journal().query({ limit: "5" });

    const [url] = mockFetch.mock.calls[0];
    const u = new URL(url);
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.has("resource")).toBe(false);
    expect(u.searchParams.has("kind")).toBe(false);
    expect(u.searchParams.has("after_seq")).toBe(false);
  });
});
