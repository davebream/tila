import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createSignalMethods } from "../signals";

describe("createSignalMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects legacy string targets before making a request", async () => {
    const signals = createSignalMethods(
      new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      "project-1",
    );

    await expect(
      signals.send({
        // @ts-expect-error deliberately exercise the runtime cutover
        target: "legacy-display-name",
        kind: "info",
      }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("validates send responses including recipient_count", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ ok: true, id: "sig_1" }));
    const signals = createSignalMethods(
      new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      "project-1",
    );

    await expect(
      signals.send({ target: { type: "broadcast" }, kind: "ready" }),
    ).rejects.toThrow("Unexpected response shape");
  });

  it("sends typed participant targets unchanged", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({ ok: true, id: "sig_1", recipient_count: 1 }),
    );
    const signals = createSignalMethods(
      new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      "project-1",
    );

    const result = await signals.send({
      target: {
        type: "participant",
        principal_id: "principal-b",
        participant_id: "participant-b",
      },
      kind: "request",
    });

    expect(result.recipient_count).toBe(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      target: {
        type: "participant",
        principal_id: "principal-b",
        participant_id: "participant-b",
      },
    });
  });
});
