import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TilaApiError } from "../client";
import {
  TILA_ERRORS,
  type TilaErrorCode,
  toTilaErrorCode,
} from "../error-codes";

/** Recursively collect all .ts files (excluding .test.ts) under a directory. */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Collect error.code string literals from a source file's content. */
function collectEmittedCodesFromContent(content: string): string[] {
  const codes: string[] = [];
  const patterns = [
    /code:\s*"([a-z][a-z0-9-]*)"/g,
    /zodValidationError\([^)]*?"([a-z][a-z0-9-]*)"/g,
    /jsonError\(\s*c\s*,\s*\d+\s*,\s*"([a-z][a-z0-9-]*)"/g,
    // multiline jsonError(c,\n  409,\n  "already-held", ...)
    /jsonError\(\s*\n\s*c\s*,\s*\n\s*\d+\s*,\s*\n\s*"([a-z][a-z0-9-]*)"/g,
  ];

  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      codes.push(m[1]);
    }
  }

  return codes;
}

/** Collect error.code string literals emitted under a source directory. */
function collectWorkerEmittedCodes(dir: string): Set<string> {
  const codes = new Set<string>();

  for (const file of collectSourceFiles(dir)) {
    const content = readFileSync(file, "utf-8");
    for (const code of collectEmittedCodesFromContent(content)) {
      codes.add(code);
    }
  }

  return codes;
}

const WORKER_SRC_DIR = join(__dirname, "../../../worker/src");
const OPS_SQLITE_SRC_DIR = join(__dirname, "../../../ops-sqlite/src");
const BACKEND_DO_SRC_DIR = join(__dirname, "../../../backend-do/src");

/** Collect error.code literals from server packages that emit HTTP errors. */
function collectServerEmittedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const dir of [WORKER_SRC_DIR, OPS_SQLITE_SRC_DIR, BACKEND_DO_SRC_DIR]) {
    for (const code of collectWorkerEmittedCodes(dir)) {
      codes.add(code);
    }
  }
  return codes;
}

/** SDK-generated codes — not emitted by the worker HTTP layer. */
const SDK_LOCAL_WIRE_CODES = new Set<string>([
  TILA_ERRORS.UNKNOWN,
  TILA_ERRORS.ARTIFACT_GET_FAILED,
  TILA_ERRORS.ARTIFACT_GET_LATEST_FAILED,
]);

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

describe("TILA_ERRORS server-emitted code reconciliation (#114, #117)", () => {
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
    "subject-revoked",
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
    "instance-mismatch",
    "permission-revoked",
    "dpop-required",
    "dpop-invalid",
  ]);

  it('contains no value equal to the orphan "TOKEN_AUTHZ_DENIED"', () => {
    expect(Object.values(TILA_ERRORS)).not.toContain("TOKEN_AUTHZ_DENIED");
  });

  it('maps "token-authz-denied" from exactly one key (REPO_TOKEN_AUTHZ_DENIED)', () => {
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

  it("every map value is emitted by the worker or is SDK-local (#117)", () => {
    const workerCodes = collectServerEmittedCodes();
    const unmapped: string[] = [];

    for (const value of Object.values(TILA_ERRORS)) {
      if (SDK_LOCAL_WIRE_CODES.has(value)) continue;
      if (!workerCodes.has(value)) {
        unmapped.push(value);
      }
    }

    expect(
      unmapped,
      `TILA_ERRORS values not found in worker emission scan: ${unmapped.join(", ")}`,
    ).toEqual([]);
  });
});
