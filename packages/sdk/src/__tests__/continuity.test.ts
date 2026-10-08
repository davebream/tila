import { afterEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import {
  createHandoffMethods,
  createJournalContinuityMethods,
} from "../continuity";

afterEach(() => vi.unstubAllGlobals());
describe("HTTP continuity facade", () => {
  it("preserves numeric replay bounds and validates the response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        events: [],
        next_after_seq: 4,
        through_seq: 4,
        has_more: false,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new TilaClient({
      baseUrl: "https://tila.test",
      token: "token",
    });
    const journal = createJournalContinuityMethods(client, "project");
    expect(
      await journal.replay({ after_seq: 4, through_seq: 4, limit: 10 }),
    ).toMatchObject({ next_after_seq: 4, has_more: false });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/projects/project/journal/replay");
    expect(url.searchParams.get("after_seq")).toBe("4");
    await expect(journal.acknowledge({ seq: -1 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sends a stable caller-supplied handoff ID and canonical request defaults", async () => {
    const id = crypto.randomUUID();
    const handoff = {
      id,
      summary: "Saved",
      based_on_seq: 0,
      current_state: {},
      findings: [],
      unresolved_questions: [],
      references: [],
      creator: { principal_id: "p", participant_id: "s", environment: {} },
      created_at: 1,
      created_seq: 1,
      active_claims: [],
    };
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ ok: true, handoff })),
      );
    vi.stubGlobal("fetch", fetch);
    const methods = createHandoffMethods(
      new TilaClient({ baseUrl: "https://tila.test", token: "token" }),
      "project",
    );
    await methods.create({ id, summary: "Saved", based_on_seq: 0 });
    await methods.create({ id, summary: "Saved", based_on_seq: 0 });
    expect(JSON.parse(fetch.mock.calls[0][1].body).id).toBe(id);
    expect(fetch.mock.calls[0][1].body).toEqual(fetch.mock.calls[1][1].body);
  });
});
