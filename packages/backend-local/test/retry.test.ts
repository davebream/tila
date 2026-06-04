import { describe, expect, it } from "vitest";
import { withBusyRetry, withBusyRetryAsync } from "../src/retry";

describe("withBusyRetry", () => {
  it("returns the result of fn on first success", () => {
    const result = withBusyRetry(() => 42);
    expect(result).toBe(42);
  });

  it("retries on SQLITE_BUSY error", () => {
    let attempts = 0;
    const result = withBusyRetry(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("retries on 'database is locked' error", () => {
    let attempts = 0;
    const result = withBusyRetry(() => {
      attempts++;
      if (attempts < 2) {
        throw new Error("database is locked");
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("rethrows after maxRetries exhausted", () => {
    let attempts = 0;
    expect(() =>
      withBusyRetry(() => {
        attempts++;
        throw new Error("SQLITE_BUSY: database is locked");
      }, 3),
    ).toThrow("SQLITE_BUSY");
    expect(attempts).toBe(3);
  });

  it("propagates non-BUSY errors immediately", () => {
    let attempts = 0;
    expect(() =>
      withBusyRetry(() => {
        attempts++;
        throw new Error("UNIQUE constraint failed");
      }),
    ).toThrow("UNIQUE constraint failed");
    expect(attempts).toBe(1);
  });

  it("handles async functions", async () => {
    let attempts = 0;
    const result = await withBusyRetryAsync(async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "async-ok";
    });
    expect(result).toBe("async-ok");
    expect(attempts).toBe(2);
  });
});
