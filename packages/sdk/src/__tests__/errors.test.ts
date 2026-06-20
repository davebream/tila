import { describe, expect, it } from "vitest";
import { TilaApiError } from "../client";
import {
  TILA_ERRORS,
  type TilaErrorCode,
  toTilaErrorCode,
} from "../error-codes";

describe("toTilaErrorCode normalizer", () => {
  it("passes through known wire codes unchanged", () => {
    expect(toTilaErrorCode("UNAUTHORIZED")).toBe("UNAUTHORIZED");
    expect(toTilaErrorCode("stale-fence")).toBe("stale-fence");
    expect(toTilaErrorCode("not-found")).toBe("not-found");
    expect(toTilaErrorCode("UNKNOWN")).toBe("UNKNOWN");
    expect(toTilaErrorCode("do-unreachable")).toBe("do-unreachable");
  });

  it("normalizes unknown wire strings to UNKNOWN", () => {
    expect(toTilaErrorCode("NETWORK_ERROR")).toBe("UNKNOWN");
    expect(toTilaErrorCode("INVALID_PAYLOAD")).toBe("UNKNOWN");
    expect(toTilaErrorCode("some-future-code")).toBe("UNKNOWN");
    expect(toTilaErrorCode("")).toBe("UNKNOWN");
  });
});

describe("repos-route error codes round-trip through toTilaErrorCode", () => {
  const reposWireCodes = [
    "token-authz-denied",
    "repo-access-denied",
    "repo-not-found",
    "github-api-timeout",
    "github-api-error",
  ] as const;

  for (const code of reposWireCodes) {
    it(`toTilaErrorCode("${code}") returns the code unchanged (not "UNKNOWN")`, () => {
      expect(toTilaErrorCode(code)).toBe(code);
      expect(toTilaErrorCode(code)).not.toBe("UNKNOWN");
    });

    it(`"${code}" is a member of Object.values(TILA_ERRORS)`, () => {
      expect(Object.values(TILA_ERRORS)).toContain(code);
    });
  }
});

describe("TilaApiError.code is TilaErrorCode", () => {
  it("has code typed as TilaErrorCode — known code", () => {
    const err = new TilaApiError(409, "stale-fence", "stale", false);
    // Type-level: err.code is TilaErrorCode (compiler check)
    const code: TilaErrorCode = err.code;
    expect(code).toBe("stale-fence");
  });

  it("unknown wire code is normalized to UNKNOWN at construction", () => {
    // Simulates throwApiError receiving a code not in TILA_ERRORS
    const err = new TilaApiError(
      500,
      toTilaErrorCode("GARBAGE_CODE"),
      "oops",
      false,
    );
    expect(err.code).toBe("UNKNOWN");
  });

  it("supports exhaustive switch over TilaErrorCode", () => {
    const err = new TilaApiError(404, "not-found", "missing", false);
    let matched = false;

    // This switch must compile — it exercises all the error code shapes.
    // We just test the runtime branch here.
    switch (err.code) {
      case TILA_ERRORS.NOT_FOUND:
        matched = true;
        break;
      default:
        // assertUnreachable is the pattern; runtime default is acceptable
        break;
    }

    expect(matched).toBe(true);
  });
});
