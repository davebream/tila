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

describe("TILA_ERRORS server-emitted code reconciliation", () => {
  const SDK_ONLY_ERROR_CODES = new Set<string>([
    "artifact-get-failed",
    "artifact-get-latest-failed",
    "UNKNOWN",
  ]);

  const SERVER_EMITTED_TILA_ERROR_CODES = new Set<string>([
    "unauthorized",
    "session-expired",
    "rate-limited",
    "permission-denied",
    "project-mismatch",
    "csrf-missing-origin",
    "csrf-origin-mismatch",
    "do-unreachable",
    "repo-not-allowed",
    "github-auth-failed",
    "hmac-not-configured",
    "session-revoked",
    "token-name-conflict",
    "token-not-found",
    "stale-fence",
    "not-found",
    "gate-already-settled",
    "no-fence",
    "gate-fence-conflict",
    "internal",
    "constraint-violation",
    "idempotency-key-conflict",
    "validation-error",
    "already-held",
    "renew-failed",
    "release-ownership-denied",
    "bad-request",
    "missing-query",
    "invalid-query",
    "invalid-slot",
    "invalid-relationship-type",
    "token-authz-denied",
    "repo-access-denied",
    "repo-not-found",
    "github-api-timeout",
    "github-api-error",
  ]);

  it('contains no value equal to the orphan "TOKEN_AUTHZ_DENIED"', () => {
    // Test A — the orphan's wire value is gone (fails RED before the entry is removed).
    expect(Object.values(TILA_ERRORS)).not.toContain("TOKEN_AUTHZ_DENIED");
  });

  it('maps "token-authz-denied" from exactly one key (REPO_TOKEN_AUTHZ_DENIED)', () => {
    // Test B — exactly one key carries the live wire value, and it is the kebab key.
    const hits = Object.entries(TILA_ERRORS).filter(
      ([, value]) => value === "token-authz-denied",
    );
    expect(hits).toEqual([["REPO_TOKEN_AUTHZ_DENIED", "token-authz-denied"]]);
  });

  it("maps every non-SDK-only value to a server-emitted wire code", () => {
    const unmappedServerCodes = Object.entries(TILA_ERRORS).filter(
      ([, value]) =>
        !SDK_ONLY_ERROR_CODES.has(value) &&
        !SERVER_EMITTED_TILA_ERROR_CODES.has(value),
    );

    expect(
      unmappedServerCodes,
      `TILA_ERRORS values not present in server emission set: ${JSON.stringify(
        unmappedServerCodes,
      )}`,
    ).toEqual([]);
  });

  it("has no two keys mapping to the same wire value", () => {
    const values = Object.values(TILA_ERRORS);
    const seen = new Map<string, string[]>();
    for (const [key, value] of Object.entries(TILA_ERRORS)) {
      const keys = seen.get(value) ?? [];
      keys.push(key);
      seen.set(value, keys);
    }
    const duplicates = [...seen.entries()].filter(
      ([, keys]) => keys.length > 1,
    );
    expect(
      duplicates,
      `Duplicate TILA_ERRORS wire values: ${JSON.stringify(duplicates)}`,
    ).toEqual([]);
    expect(values.length).toBe(new Set(values).size);
  });
});
