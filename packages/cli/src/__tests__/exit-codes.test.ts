import { TILA_ERRORS } from "tila-sdk";
/**
 * Tests for EXIT_CODES and exitCodeFor classifier.
 */
import { describe, expect, it } from "vitest";
import { EXIT_CODES, exitCodeFor } from "../lib/exit-codes";

describe("EXIT_CODES", () => {
  it("exports SUCCESS=0, USER_ERROR=1, NETWORK_ERROR=2", () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.USER_ERROR).toBe(1);
    expect(EXIT_CODES.NETWORK_ERROR).toBe(2);
  });
});

describe("exitCodeFor", () => {
  it("maps do-unreachable to NETWORK_ERROR (2)", () => {
    expect(exitCodeFor(TILA_ERRORS.DO_UNREACHABLE)).toBe(
      EXIT_CODES.NETWORK_ERROR,
    );
  });

  it("maps RATE_LIMITED to NETWORK_ERROR (2)", () => {
    expect(exitCodeFor(TILA_ERRORS.RATE_LIMITED)).toBe(
      EXIT_CODES.NETWORK_ERROR,
    );
  });

  it("maps internal to NETWORK_ERROR (2)", () => {
    expect(exitCodeFor(TILA_ERRORS.INTERNAL)).toBe(EXIT_CODES.NETWORK_ERROR);
  });

  it("maps internal (kebab) to NETWORK_ERROR (2)", () => {
    expect(exitCodeFor(TILA_ERRORS.INTERNAL)).toBe(EXIT_CODES.NETWORK_ERROR);
  });

  it("maps stale-fence to USER_ERROR (1)", () => {
    expect(exitCodeFor(TILA_ERRORS.STALE_FENCE)).toBe(EXIT_CODES.USER_ERROR);
  });

  it("maps UNAUTHORIZED to USER_ERROR (1)", () => {
    expect(exitCodeFor(TILA_ERRORS.UNAUTHORIZED)).toBe(EXIT_CODES.USER_ERROR);
  });

  it("maps ALREADY_HELD to USER_ERROR (1)", () => {
    expect(exitCodeFor(TILA_ERRORS.ALREADY_HELD)).toBe(EXIT_CODES.USER_ERROR);
  });

  it("maps VALIDATION_ERROR to USER_ERROR (1)", () => {
    expect(exitCodeFor(TILA_ERRORS.VALIDATION_ERROR)).toBe(
      EXIT_CODES.USER_ERROR,
    );
  });

  it("maps not-found to USER_ERROR (1)", () => {
    expect(exitCodeFor(TILA_ERRORS.NOT_FOUND)).toBe(EXIT_CODES.USER_ERROR);
  });

  it("maps UNKNOWN to USER_ERROR (1)", () => {
    expect(exitCodeFor(TILA_ERRORS.UNKNOWN)).toBe(EXIT_CODES.USER_ERROR);
  });

  it("maps unmapped strings to USER_ERROR (1) — never silently NETWORK_ERROR", () => {
    // The stale literal "NETWORK_ERROR" is NOT a TILA_ERRORS member → defaults to USER_ERROR
    expect(exitCodeFor("NETWORK_ERROR")).toBe(EXIT_CODES.USER_ERROR);
    expect(exitCodeFor("INVALID_PAYLOAD")).toBe(EXIT_CODES.USER_ERROR);
    expect(exitCodeFor("some-future-unknown-code")).toBe(EXIT_CODES.USER_ERROR);
  });
});
