import { describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import {
  createConversationMethods,
  createInboxMethods,
} from "../conversations";

const id = () => crypto.randomUUID();
const summary = { recipients: 1, pending: 1, acknowledged: 0, expired: 0 };

describe("delivery trace SDK contracts", () => {
  const setup = () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new TilaClient({
      baseUrl: "https://example.test",
      token: "fixture",
      participantId: "participant",
      fetch,
    });
    return {
      fetch,
      rooms: createConversationMethods(client, "project"),
      inbox: createInboxMethods(client, "project"),
    };
  };

  it("reads a restricted message summary without recipient details", async () => {
    const { fetch, rooms } = setup();
    const message = id();
    fetch.mockResolvedValueOnce(
      Response.json({ ok: true, restricted: true, summary }),
    );
    const result = await rooms.deliveries("general", message);
    expect(result).toEqual({ ok: true, restricted: true, summary });
    expect(String(fetch.mock.calls[0][0])).toBe(
      `https://example.test/projects/project/rooms/general/messages/${message}/deliveries`,
    );
    expect(() => rooms.deliveries("general", "not-a-uuid")).toThrow();
  });

  it("sends delivery filters and the page cursor", async () => {
    const { fetch, inbox } = setup();
    fetch.mockResolvedValueOnce(
      Response.json({
        ok: true,
        deliveries: [],
        has_more: false,
        cursor: null,
      }),
    );
    await inbox.deliveries({
      agent: "worker",
      state: "expired",
      limit: 10,
      cursor: "c",
    });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/projects/project/deliveries");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agent: "worker",
      state: "expired",
      limit: "10",
      cursor: "c",
    });
    expect(() => inbox.deliveries({ state: "done" as "acked" })).toThrow();
  });
});
