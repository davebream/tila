import { afterEach, describe, expect, it, vi } from "vitest";
import { TilaApiError } from "../client";
import { withRetry } from "../retry";

describe("withRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries on transient error and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 0,
      jitter: false,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("hard-stops on TilaApiError with retryable: false (attempt 0)", async () => {
    const apiErr = new TilaApiError(409, "stale-fence", "stale fence", false);
    const fn = vi.fn().mockRejectedValueOnce(apiErr);

    await expect(withRetry(fn, { maxRetries: 5 })).rejects.toThrow(apiErr);
    // Hard stop: only called once, no retries
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries TilaApiError with retryable: true", async () => {
    const retryableErr = new TilaApiError(
      429,
      "RATE_LIMITED",
      "rate limited",
      true,
    );
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableErr)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 0,
      jitter: false,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after maxRetries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 0, jitter: false }),
    ).rejects.toThrow("ECONNREFUSED");
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries non-TilaApiError errors (timeout, TypeError)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Request to https://api.test timed out after 5000ms"),
      )
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 0,
      jitter: false,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects maxDelayMs cap: sleep duration is bounded by maxDelayMs", async () => {
    // Spy on setTimeout to capture the delay value without actually waiting
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (fn: TimerHandler, ms?: number) => {
        if (typeof ms === "number") delays.push(ms);
        if (typeof fn === "function") fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"));

    await expect(
      withRetry(fn, {
        maxRetries: 1,
        baseDelayMs: 100_000,
        maxDelayMs: 500,
        jitter: false,
      }),
    ).rejects.toThrow("fail");

    // The delay for attempt 0: min(500, 100000 * 2^0) = min(500, 100000) = 500
    expect(delays.length).toBeGreaterThanOrEqual(1);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(500);
    }
    // Specifically, with jitter: false, delay should be exactly 500
    expect(delays[0]).toBe(500);
  });

  it("applies jitter: delay is random in range [0, cap]", async () => {
    // Mock Math.random to return 0.5
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (fn: TimerHandler, ms?: number) => {
        if (typeof ms === "number") delays.push(ms);
        if (typeof fn === "function") fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"));

    await expect(
      withRetry(fn, {
        maxRetries: 1,
        baseDelayMs: 200,
        maxDelayMs: 30_000,
        jitter: true,
      }),
    ).rejects.toThrow("fail");

    // With random=0.5 and attempt 0: cap = min(30000, 200 * 2^0) = 200, delay = 0.5 * 200 = 100
    expect(delays.length).toBeGreaterThanOrEqual(1);
    expect(delays[0]).toBe(100);
  });
});
