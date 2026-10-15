import { JournalResponseSchema } from "@tila/schemas";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
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

  it("appends with the explicit retry key and parses the authenticated receipt", async () => {
    const input = {
      event_name: "pipeline.tests_passed",
      event_version: 1,
      target: { kind: "project" as const },
      data: {},
    };
    const receipt = {
      ok: true,
      event: {
        seq: 7,
        t: 100,
        kind: "custom.reported",
        resource: "project:proj-1",
        principal_id: "principal",
        participant_id: "participant",
        environment: {},
        token_id: "token",
        fence: null,
        data: input,
      },
      dedup_expires_at: 604800100,
    };
    mockFetch.mockResolvedValueOnce(ok(receipt));
    expect(await journal().append(input, { idempotencyKey: "stable" })).toEqual(
      receipt,
    );
    const [url, init] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/projects/proj-1/journal");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("stable");
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it("reports typed validation failures without making a network request", async () => {
    const input = {
      event_name: "pipeline.tests_passed",
      event_version: 1,
      target: { kind: "project" as const },
      data: { text: "x".repeat(17_000) },
    };
    await expect(
      journal().append(input, { idempotencyKey: "key" }),
    ).rejects.toMatchObject({ code: "payload-too-large", status: 413 });
    await expect(
      journal().append({ ...input, data: {} }, { idempotencyKey: "" }),
    ).rejects.toMatchObject({ code: "validation-error", status: 400 });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("journal list archive metadata", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // What the Worker route emits for a cursor below the archive watermark.
  const archivedPage = {
    ok: true,
    events: [],
    archived: true,
    lastArchivedSeq: 40,
  };

  function client() {
    return new TilaClient({ baseUrl: "https://api.test", token: "t" });
  }

  it("types and returns the watermark so a caller can tell archived from caught up", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(archivedPage), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const page = await createJournalMethods(client(), "proj-1").query({
      after_seq: "12",
      limit: "50",
    });

    expectTypeOf(page.archived).toEqualTypeOf<boolean | undefined>();
    expectTypeOf(page.lastArchivedSeq).toEqualTypeOf<
      number | null | undefined
    >();
    // An empty page below the watermark is not "caught up": read replay.
    const mustReplay = page.events.length === 0 && page.archived === true;
    expect(mustReplay).toBe(true);
    expect(page.lastArchivedSeq).toBe(40);
  });

  it("keeps the metadata when the client validates against the canonical schema", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(archivedPage), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const page = await client().get("/projects/proj-1/journal", {
      schema: JournalResponseSchema,
      validate: true,
      query: { after_seq: "12" },
    });

    expect(page).toEqual(archivedPage);
  });

  it("accepts a list response from a backend that omits the metadata", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, events: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const page = await client().get("/projects/proj-1/journal", {
      schema: JournalResponseSchema,
      validate: true,
    });

    expect(page).toEqual({ ok: true, events: [] });
  });
});
