import { describe, expect, it } from "vitest";
import {
  asEpochMillis,
  asEpochSeconds,
  isIssuedBeforeRevocation,
  millisToSeconds,
  secondsToMillis,
} from "./time";

// Concrete tombstone instant for boundary invariant tests
const T = asEpochMillis(1_700_000_000_000);

describe("isIssuedBeforeRevocation", () => {
  it("returns true when issuedAt is 1ms before the tombstone (strict <)", () => {
    expect(isIssuedBeforeRevocation(asEpochMillis(T - 1), T)).toBe(true);
  });

  it("returns false when issuedAt equals the tombstone (strict <, not <=)", () => {
    expect(isIssuedBeforeRevocation(T, T)).toBe(false);
  });

  it("returns false when issuedAt is 1ms after the tombstone", () => {
    expect(isIssuedBeforeRevocation(asEpochMillis(T + 1), T)).toBe(false);
  });
});

describe("secondsToMillis / millisToSeconds converters", () => {
  it("lossless round-trip: millisToSeconds(secondsToMillis(s)) === s", () => {
    const s = asEpochSeconds(1_700_000_000);
    expect(millisToSeconds(secondsToMillis(s))).toBe(s);
  });

  it("lossy round-trip: secondsToMillis(millisToSeconds(ms)) floors to whole second", () => {
    // A ms value with a non-zero sub-second remainder
    const ms = asEpochMillis(1_700_000_000_123);
    const remainder = (ms as number) % 1000;
    const roundTripped = secondsToMillis(millisToSeconds(ms));
    // The round-trip loses exactly the sub-second remainder
    expect((ms as number) - (roundTripped as number)).toBe(remainder);
  });

  it("secondsToMillis is lossless (x1000, no fractional drift)", () => {
    const s = asEpochSeconds(1_700_000_000);
    expect(secondsToMillis(s) as number).toBe((s as number) * 1000);
  });
});

describe("off-by-1000 regression: seconds-vs-ms comparison", () => {
  it("a session iat in seconds, converted to ms, is correctly NOT revoked by a tombstone at T", () => {
    // Session issued 1 second AFTER the tombstone instant → should NOT be revoked
    const issuedAtSeconds = asEpochSeconds(
      Math.floor((T as number) / 1000) + 1,
    );
    const issuedAtMs = secondsToMillis(issuedAtSeconds);
    expect(isIssuedBeforeRevocation(issuedAtMs, T)).toBe(false);
  });

  it("a session iat in seconds, converted to ms, IS revoked when issued 1 second before tombstone", () => {
    // Session issued 1 second BEFORE the tombstone instant → should be revoked
    const issuedAtSeconds = asEpochSeconds(
      Math.floor((T as number) / 1000) - 1,
    );
    const issuedAtMs = secondsToMillis(issuedAtSeconds);
    expect(isIssuedBeforeRevocation(issuedAtMs, T)).toBe(true);
  });

  it("WITHOUT conversion, a raw seconds value (magnitude ~1.7e9) is always less than a ms tombstone (magnitude ~1.7e12)", () => {
    // This documents the off-by-1000 footgun: if you pass seconds directly where ms
    // is expected, the wrong verdict is produced (every token looks revoked).
    const issuedAtSeconds = asEpochSeconds(
      Math.floor((T as number) / 1000) + 1,
    );
    // The raw number (seconds) is numerically smaller than T (ms) → wrong verdict
    expect((issuedAtSeconds as number) < (T as number)).toBe(true);
    // With proper conversion it's correct:
    expect((secondsToMillis(issuedAtSeconds) as number) < (T as number)).toBe(
      false,
    );
  });
});

// Compile-time cross-unit guard — verified by `pnpm --filter @tila/worker typecheck`, not vitest.
// The @ts-expect-error line below proves that passing an EpochSeconds value where EpochMillis
// is required does NOT compile. If the directive is ever unused (no type error), typecheck fails.
describe("compile-time branded-type guard", () => {
  it("@ts-expect-error: EpochSeconds is not assignable to EpochMillis parameter", () => {
    const tombstoneMs = asEpochMillis(1_700_000_000_000);
    const issuedAtSeconds = asEpochSeconds(1_700_000_000);
    // @ts-expect-error seconds value is not EpochMillis — this must remain a type error
    isIssuedBeforeRevocation(issuedAtSeconds, tombstoneMs);
    // vitest must reach here to report the test as green (the runtime call succeeds — branded
    // types are erased at runtime; the guard is enforced by tsc/typecheck only)
    expect(true).toBe(true);
  });
});
