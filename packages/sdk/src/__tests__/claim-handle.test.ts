import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimHandle, withClaim } from "../claim-handle";
import { TilaApiError, TilaClient } from "../client";

describe("withClaim", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("acquires, runs callback, and releases on success", async () => {
    // Mock acquire
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          fence: 5,
          expires_at: Date.now() + 60000,
          resource: "r1",
          mode: "exclusive",
        }),
        { status: 200 },
      ),
    );
    // Mock release
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const result = await withClaim(
      client,
      "proj-1",
      "resource/1",
      "exclusive",
      30000,
      async (handle) => {
        expect(handle.fence).toBe(5);
        return "done";
      },
    );

    expect(result).toBe("done");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("releases claim even when callback throws", async () => {
    // Mock acquire
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          fence: 7,
          expires_at: Date.now() + 60000,
          resource: "r1",
          mode: "exclusive",
        }),
        { status: 200 },
      ),
    );
    // Mock release
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });

    await expect(
      withClaim(
        client,
        "proj-1",
        "resource/1",
        "exclusive",
        30000,
        async () => {
          throw new Error("callback failed");
        },
      ),
    ).rejects.toThrow("callback failed");

    // Release was called (2 fetch calls total)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("propagates original error even if release fails", async () => {
    // Mock acquire
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          fence: 3,
          expires_at: Date.now() + 60000,
          resource: "r1",
          mode: "exclusive",
        }),
        { status: 200 },
      ),
    );
    // Mock release -- fails with 500
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "INTERNAL", message: "oops", retryable: false },
        }),
        { status: 500 },
      ),
    );

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      withClaim(
        client,
        "proj-1",
        "resource/1",
        "exclusive",
        30000,
        async () => {
          throw new Error("original error");
        },
      ),
    ).rejects.toThrow("original error");

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("ClaimHandle.startHeartbeat", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("emits error event on 409 heartbeat rejection", async () => {
    const handle = new ClaimHandle({
      client: new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      projectId: "proj-1",
      resource: "r1",
      fence: 10,
      expiresAt: Date.now() + 60000,
    });

    const errorHandler = vi.fn();
    handle.on("error", errorHandler);

    // Mock heartbeat (renew) -- returns 409
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "FENCE_CONFLICT", message: "stale", retryable: false },
        }),
        { status: 409 },
      ),
    );

    const hb = handle.startHeartbeat(30000);

    // Advance past the heartbeat interval (default 40% of TTL = 12000ms)
    await vi.advanceTimersByTimeAsync(12000);

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(TilaApiError);
    expect(errorHandler.mock.calls[0][0].status).toBe(409);

    hb.stop();
  });

  it("stop() clears the heartbeat interval", async () => {
    const handle = new ClaimHandle({
      client: new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      projectId: "proj-1",
      resource: "r1",
      fence: 5,
      expiresAt: Date.now() + 60000,
    });

    const hb = handle.startHeartbeat(30000);
    hb.stop();

    // Mock a renew response that should never be called
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await vi.advanceTimersByTimeAsync(30000);
    // fetch should not have been called for heartbeat after stop
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("ClaimHandle.onClaimExpiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires callback leadMs before expiresAt", async () => {
    const now = Date.now();
    const handle = new ClaimHandle({
      client: new TilaClient({ baseUrl: "https://api.test", token: "t" }),
      projectId: "proj-1",
      resource: "r1",
      fence: 5,
      expiresAt: now + 60000, // expires in 60s
    });

    const callback = vi.fn();
    handle.onClaimExpiring(10000, callback); // fire 10s before expiry = at 50s

    await vi.advanceTimersByTimeAsync(49000);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(callback).toHaveBeenCalledOnce();
  });
});
