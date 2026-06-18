/**
 * Unit tests for extracted auth-github helper functions.
 * Mandatory per plan Task 9 (C3) — ensures the refactor covers all duplication
 * sites and the helpers behave correctly in isolation.
 */
import type { D1IdempotencyStore } from "@tila/backend-d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mock for @tila/backend-d1 — must be hoisted before imports
// so recordExchangeFailure sees the mock when it constructs D1RateLimitStore.
// ---------------------------------------------------------------------------
const mockRecordFailure = vi.fn();

vi.mock("@tila/backend-d1", () => ({
  D1RateLimitStore: vi.fn().mockImplementation(
    class {
      recordFailure = mockRecordFailure;
      check = vi.fn().mockResolvedValue(false);
    } as unknown as () => unknown,
  ),
  D1IdempotencyStore: vi.fn().mockImplementation(
    class {
      check = vi.fn().mockResolvedValue(null);
      store = vi.fn().mockResolvedValue(undefined);
    } as unknown as () => unknown,
  ),
  // Other exports used by auth-github.ts (stubs only)
  D1TokenStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  D1SessionStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  GitHubAppConfigStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
  RepoAllowlistStore: vi
    .fn()
    .mockImplementation(class {} as unknown as () => unknown),
}));

// Import helpers AFTER mocks are hoisted
const { checkIdempotentExchange, recordExchangeFailure } = await import(
  "./auth-github"
);

// ---------------------------------------------------------------------------
// recordExchangeFailure
// ---------------------------------------------------------------------------

describe("recordExchangeFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when ip is null", async () => {
    const writeDataPoint = vi.fn();
    const env = {
      DB: {} as unknown as D1Database,
      ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    };

    await recordExchangeFailure(env, null);

    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("calls D1 recordFailure with the correct key when ip is present", async () => {
    mockRecordFailure.mockResolvedValue(undefined);
    const writeDataPoint = vi.fn();
    const env = {
      DB: {} as unknown as D1Database,
      ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    };

    await recordExchangeFailure(env, "1.2.3.4");

    expect(mockRecordFailure).toHaveBeenCalledWith(
      "exchange:1.2.3.4",
      expect.any(Number),
    );
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("emits the rate_limit_d1_error analytics datapoint when D1 recordFailure throws", async () => {
    mockRecordFailure.mockRejectedValue(new Error("D1 unavailable"));
    const writeDataPoint = vi.fn();
    const env = {
      DB: {} as unknown as D1Database,
      ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    };

    await recordExchangeFailure(env, "5.6.7.8");

    // D1 failed — analytics fallback must fire with the expected blobs
    expect(writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: ["auth", "rate_limit_d1_error", "record_failure"],
        doubles: [1],
        indexes: ["rate-limit"],
      }),
    );
  });

  it("does not throw when both D1 and Analytics fail", async () => {
    mockRecordFailure.mockRejectedValue(new Error("D1 down"));
    const env = {
      DB: {} as unknown as D1Database,
      ANALYTICS: {
        writeDataPoint: vi.fn().mockImplementation(() => {
          throw new Error("analytics also down");
        }),
      } as unknown as AnalyticsEngineDataset,
    };

    // Should not throw — both errors are swallowed
    await expect(
      recordExchangeFailure(env, "9.9.9.9"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkIdempotentExchange
// ---------------------------------------------------------------------------

describe("checkIdempotentExchange", () => {
  const mockRun = vi.fn().mockResolvedValue(undefined);
  const mockBind = vi.fn().mockReturnValue({ run: mockRun });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
  const mockDb = { prepare: mockPrepare } as unknown as D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when store.check returns null (cache miss)", async () => {
    const mockStore = {
      check: vi.fn().mockResolvedValue(null),
    } as unknown as D1IdempotencyStore;

    const result = await checkIdempotentExchange(
      mockStore,
      "exchange:proj1:hash",
      "proj1",
      mockDb,
    );

    expect(result).toBeNull();
    expect(mockStore.check).toHaveBeenCalledWith(
      "exchange:proj1:hash",
      "proj1",
    );
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("passes projectId to store.check (scopes by project)", async () => {
    const mockStore = {
      check: vi.fn().mockResolvedValue(null),
    } as unknown as D1IdempotencyStore;

    await checkIdempotentExchange(mockStore, "key1", "project-A", mockDb);
    expect(mockStore.check).toHaveBeenCalledWith("key1", "project-A");

    await checkIdempotentExchange(mockStore, "key1", "project-B", mockDb);
    expect(mockStore.check).toHaveBeenCalledWith("key1", "project-B");
  });

  it("returns cached body when expires_at is in the future", async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const cachedResponseBody = {
      ok: true,
      session_token: "tila_s.abc",
      expires_at: futureExpiry,
      project_id: "proj1",
    };
    const mockStore = {
      check: vi.fn().mockResolvedValue({
        body: JSON.stringify(cachedResponseBody),
        statusCode: 200,
      }),
    } as unknown as D1IdempotencyStore;

    const result = await checkIdempotentExchange(
      mockStore,
      "exchange:proj1:hash",
      "proj1",
      mockDb,
    );

    expect(result).toEqual(cachedResponseBody);
    expect(mockPrepare).not.toHaveBeenCalled(); // no stale-delete
  });

  it("deletes stale entry and returns null when expires_at is in the past", async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 100;
    const staleBody = { ok: true, expires_at: pastExpiry };
    const mockStore = {
      check: vi.fn().mockResolvedValue({
        body: JSON.stringify(staleBody),
        statusCode: 200,
      }),
    } as unknown as D1IdempotencyStore;

    const result = await checkIdempotentExchange(
      mockStore,
      "exchange:proj1:hash",
      "proj1",
      mockDb,
    );

    expect(result).toBeNull();
    expect(mockPrepare).toHaveBeenCalledWith(
      "DELETE FROM _idempotency WHERE key = ?",
    );
    expect(mockBind).toHaveBeenCalledWith("exchange:proj1:hash");
    expect(mockRun).toHaveBeenCalled();
  });

  it("returns null and does not throw when cached body is malformed JSON", async () => {
    const mockStore = {
      check: vi.fn().mockResolvedValue({
        body: "NOT-VALID-JSON",
        statusCode: 200,
      }),
    } as unknown as D1IdempotencyStore;

    const result = await checkIdempotentExchange(
      mockStore,
      "exchange:proj1:hash",
      "proj1",
      mockDb,
    );

    expect(result).toBeNull();
    expect(mockPrepare).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Call-site count assertions: ensures all duplication sites were extracted
// ---------------------------------------------------------------------------

describe("call-site count assertions (C3 regression guard)", () => {
  it("recordExchangeFailure is called at exactly 7 sites in auth-github.ts", async () => {
    // Read the source file and count occurrences of recordExchangeFailure calls.
    // This catches a dropped site if a future edit forgets to use the helper.
    // Duplication sites:
    //  1. handleAppExchange — github auth fail
    //  2. handleAppExchange — permission fail
    //  3. /exchange PAT handler — github auth fail
    //  4. /exchange PAT handler — permission fail
    //  5. /exchange-oidc — OIDC token error (401 path)
    //  6. /exchange-oidc — repo not registered
    //  7. /app-config — invalid/revoked token (SEC-5)
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const src = readFileSync(join(__dirname, "auth-github.ts"), "utf-8");

    const callSites = (src.match(/await recordExchangeFailure\(/g) ?? [])
      .length;
    expect(callSites).toBe(7);
  });

  it("checkExchangeRateLimit is called at exactly 3 sites, with RATE_LIMITED defined once", async () => {
    // The upfront rate-limit check was extracted from 3 byte-identical inline
    // blocks (/exchange, /exchange-oidc, /app-config) into checkExchangeRateLimit.
    // This guards against a future edit re-inlining a copy.
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const src = readFileSync(join(__dirname, "auth-github.ts"), "utf-8");

    const callSites = (src.match(/await checkExchangeRateLimit\(/g) ?? [])
      .length;
    expect(callSites).toBe(3);

    // The RATE_LIMITED 429 response should be authored exactly once (inside the
    // helper); a count > 1 means a block was re-inlined into a route.
    const rateLimitedLiterals = (src.match(/code: "rate-limited"/g) ?? [])
      .length;
    expect(rateLimitedLiterals).toBe(1);
  });

  it("checkIdempotentExchange is called at exactly 3 sites in auth-github.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const src = readFileSync(join(__dirname, "auth-github.ts"), "utf-8");

    const callSites = (src.match(/await checkIdempotentExchange\(/g) ?? [])
      .length;
    expect(callSites).toBe(3);
  });

  it("OIDC tail uses mintAndStoreSession (not inline mint)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const src = readFileSync(join(__dirname, "auth-github.ts"), "utf-8");

    // Check that the OIDC handler calls mintAndStoreSession
    const oidcHandlerIdx = src.indexOf("/exchange-oidc");
    expect(oidcHandlerIdx).toBeGreaterThan(-1);
    const oidcSection = src.slice(oidcHandlerIdx);
    expect(oidcSection).toContain("await mintAndStoreSession(");

    // Confirm no inline payload construction in the OIDC handler body
    const oidcHandlerBody = src.slice(oidcHandlerIdx, oidcHandlerIdx + 2000);
    expect(oidcHandlerBody).not.toMatch(/const payload = \{/);
  });
});
