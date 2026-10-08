import { describe, expect, it } from "vitest";
import { TilaApiError } from "../client";
import {
  TILA_ERRORS,
  type TilaErrorCode,
  toTilaErrorCode,
} from "../error-codes";

describe("toTilaErrorCode normalizer", () => {
  it("passes through known wire codes unchanged", () => {
    expect(toTilaErrorCode("unauthorized")).toBe("unauthorized");
    expect(toTilaErrorCode("rate-limited")).toBe("rate-limited");
    expect(toTilaErrorCode("stale-fence")).toBe("stale-fence");
    expect(toTilaErrorCode("not-found")).toBe("not-found");
    expect(toTilaErrorCode("UNKNOWN")).toBe("UNKNOWN");
    expect(toTilaErrorCode("do-unreachable")).toBe("do-unreachable");
  });

  it("passes through worker-emitted kebab auth and middleware codes", () => {
    const workerWireCodes = [
      "unauthorized",
      "session-expired",
      "rate-limited",
      "hmac-not-configured",
      "session-revoked",
      "permission-denied",
      "project-mismatch",
      "csrf-missing-origin",
      "csrf-origin-mismatch",
      "repo-not-allowed",
      "access-policy-invalid",
      "github-auth-failed",
      "token-name-conflict",
      "token-not-found",
      "validation-error",
      "internal",
    ] as const;

    for (const code of workerWireCodes) {
      expect(toTilaErrorCode(code)).toBe(code);
      expect(toTilaErrorCode(code)).not.toBe("UNKNOWN");
    }
  });

  it("normalizes stale SCREAMING worker codes to UNKNOWN", () => {
    expect(toTilaErrorCode("UNAUTHORIZED")).toBe("UNKNOWN");
    expect(toTilaErrorCode("RATE_LIMITED")).toBe("UNKNOWN");
    expect(toTilaErrorCode("HMAC_NOT_CONFIGURED")).toBe("UNKNOWN");
    expect(toTilaErrorCode("VALIDATION_ERROR")).toBe("UNKNOWN");
  });

  it("normalizes unknown wire strings to UNKNOWN", () => {
    expect(toTilaErrorCode("NETWORK_ERROR")).toBe("UNKNOWN");
    expect(toTilaErrorCode("INVALID_PAYLOAD")).toBe("UNKNOWN");
    expect(toTilaErrorCode("some-future-code")).toBe("UNKNOWN");
    expect(toTilaErrorCode("")).toBe("UNKNOWN");
    expect(toTilaErrorCode("UNAUTHORIZED")).toBe("UNKNOWN");
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

describe("instance-mismatch error code", () => {
  it('TILA_ERRORS.INSTANCE_MISMATCH has wire value "instance-mismatch"', () => {
    expect(TILA_ERRORS.INSTANCE_MISMATCH).toBe("instance-mismatch");
  });

  it('"instance-mismatch" is a member of Object.values(TILA_ERRORS)', () => {
    expect(Object.values(TILA_ERRORS)).toContain("instance-mismatch");
  });

  it('toTilaErrorCode("instance-mismatch") returns the code unchanged (not "UNKNOWN")', () => {
    expect(toTilaErrorCode("instance-mismatch")).toBe("instance-mismatch");
    expect(toTilaErrorCode("instance-mismatch")).not.toBe("UNKNOWN");
  });
});

describe("DPoP error codes (WI-G)", () => {
  it('TILA_ERRORS.DPOP_REQUIRED has wire value "dpop-required"', () => {
    expect(TILA_ERRORS.DPOP_REQUIRED).toBe("dpop-required");
  });

  it('TILA_ERRORS.DPOP_INVALID has wire value "dpop-invalid"', () => {
    expect(TILA_ERRORS.DPOP_INVALID).toBe("dpop-invalid");
  });

  it('toTilaErrorCode("dpop-required") returns the code unchanged (not "UNKNOWN")', () => {
    expect(toTilaErrorCode("dpop-required")).toBe("dpop-required");
    expect(toTilaErrorCode("dpop-required")).not.toBe("UNKNOWN");
  });

  it('toTilaErrorCode("dpop-invalid") returns the code unchanged (not "UNKNOWN")', () => {
    expect(toTilaErrorCode("dpop-invalid")).toBe("dpop-invalid");
    expect(toTilaErrorCode("dpop-invalid")).not.toBe("UNKNOWN");
  });
});
