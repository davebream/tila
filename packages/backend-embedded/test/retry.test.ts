import { describe, expect, it } from "vitest";
import { withBusyRetry } from "../src/retry";

describe("withBusyRetry (runtime-neutral, injected sleepSync)", () => {
  it("returns the result of fn on first success without sleeping", () => {
    let sleeps = 0;
    const result = withBusyRetry(
      () => 42,
      () => {
        sleeps++;
      },
    );
    expect(result).toBe(42);
    expect(sleeps).toBe(0);
  });

  it("retries on SQLITE_BUSY and calls the injected sleepSync between attempts", () => {
    let attempts = 0;
    const sleepMs: number[] = [];
    const result = withBusyRetry(
      () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return "ok";
      },
      (ms) => {
        sleepMs.push(ms);
      },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    // Slept once before attempt 2 and once before attempt 3.
    expect(sleepMs).toHaveLength(2);
    expect(sleepMs.every((ms) => ms > 0)).toBe(true);
  });

  it("retries on 'database is locked'", () => {
    let attempts = 0;
    const result = withBusyRetry(
      () => {
        attempts++;
        if (attempts < 2) throw new Error("database is locked");
        return "ok";
      },
      () => {},
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("detects SQLITE_BUSY wrapped in err.cause (Drizzle wrap)", () => {
    let attempts = 0;
    const result = withBusyRetry(
      () => {
        attempts++;
        if (attempts < 2) {
          throw new Error("Failed to run the query", {
            cause: new Error("SQLITE_BUSY: database is locked"),
          });
        }
        return "ok";
      },
      () => {},
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("rethrows after maxRetries exhausted", () => {
    let attempts = 0;
    expect(() =>
      withBusyRetry(
        () => {
          attempts++;
          throw new Error("SQLITE_BUSY: database is locked");
        },
        () => {},
        3,
      ),
    ).toThrow("SQLITE_BUSY");
    expect(attempts).toBe(3);
  });

  it("propagates non-BUSY errors immediately without sleeping", () => {
    let attempts = 0;
    let sleeps = 0;
    expect(() =>
      withBusyRetry(
        () => {
          attempts++;
          throw new Error("UNIQUE constraint failed");
        },
        () => {
          sleeps++;
        },
      ),
    ).toThrow("UNIQUE constraint failed");
    expect(attempts).toBe(1);
    expect(sleeps).toBe(0);
  });
});
