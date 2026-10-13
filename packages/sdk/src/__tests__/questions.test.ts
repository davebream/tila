import { describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { RemoteQuestionBackend } from "../questions";

describe("question list SDK contract", () => {
  it("sends the escalated filter and accepts a total", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new TilaClient({
      baseUrl: "https://example.test",
      token: "fixture",
      participantId: "participant",
      fetch,
    });
    fetch.mockResolvedValueOnce(
      Response.json({
        ok: true,
        result: { questions: [], next_after_id: null, total: 4 },
      }),
    );
    const result = await new RemoteQuestionBackend(client, "project").list({
      state: "open",
      escalated: true,
      limit: 1,
    });
    expect(result.total).toBe(4);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/projects/project/questions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      state: "open",
      escalated: "true",
      limit: "1",
    });
  });
});
