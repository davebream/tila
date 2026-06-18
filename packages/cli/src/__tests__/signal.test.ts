import { TILA_ERRORS } from "tila-sdk";
/**
 * Tests for signal.ts error code mapping (C2 fix).
 *
 * After C2, signal.ts maps errors to real TILA_ERRORS codes instead of
 * the ad-hoc literals "NETWORK_ERROR" and "INVALID_PAYLOAD".
 */
import { describe, expect, it } from "vitest";
import { EXIT_CODES, exitCodeFor } from "../lib/exit-codes";

describe("signal error code mapping (C1↔C2 seam)", () => {
  it("a real network error code from TILA_ERRORS is classified as NETWORK_ERROR (exit 2)", () => {
    // signal send/inbox/ack failures use TILA_ERRORS.DO_UNREACHABLE for
    // network-type failures (not the old literal "NETWORK_ERROR")
    expect(exitCodeFor(TILA_ERRORS.DO_UNREACHABLE)).toBe(
      EXIT_CODES.NETWORK_ERROR,
    );
    expect(exitCodeFor(TILA_ERRORS.INTERNAL_ERROR)).toBe(
      EXIT_CODES.NETWORK_ERROR,
    );
    expect(exitCodeFor(TILA_ERRORS.RATE_LIMITED)).toBe(
      EXIT_CODES.NETWORK_ERROR,
    );
  });

  it("VALIDATION_ERROR_DO (used for invalid payload) is classified as USER_ERROR (exit 1)", () => {
    // signal send :54 INVALID_PAYLOAD → TILA_ERRORS.VALIDATION_ERROR_DO after C2
    expect(exitCodeFor(TILA_ERRORS.VALIDATION_ERROR_DO)).toBe(
      EXIT_CODES.USER_ERROR,
    );
  });

  it("old pre-C2 literal 'NETWORK_ERROR' is NOT a TILA_ERRORS member → classifies to USER_ERROR", () => {
    // This validates the fix: before C2, signal.ts used the literal string
    // "NETWORK_ERROR" which exits 1 (not 2), misleading automation.
    // After C2 it uses real TILA_ERRORS codes.
    // The old literal must not accidentally be treated as retryable.
    expect(exitCodeFor("NETWORK_ERROR")).toBe(EXIT_CODES.USER_ERROR);
  });

  it("old pre-C2 literal 'INVALID_PAYLOAD' classifies to USER_ERROR", () => {
    expect(exitCodeFor("INVALID_PAYLOAD")).toBe(EXIT_CODES.USER_ERROR);
  });

  it("TILA_ERRORS.INTERNAL (do-layer 'internal') is classified as NETWORK_ERROR", () => {
    // This covers the DO-layer 'internal' error which is a server-side issue
    expect(exitCodeFor(TILA_ERRORS.INTERNAL)).toBe(EXIT_CODES.NETWORK_ERROR);
  });
});
