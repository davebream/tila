/**
 * makeAuthEnv — builds a static Env shape for auth test apps.
 *
 * Supplies the structural Env binding stubs only. Store BEHAVIOR is controlled
 * by a per-test-file hoisted vi.mock("@tila/backend-d1", () => backendD1MockFactory())
 * — not by this function. makeAuthEnv does NOT own store behavior.
 *
 * The PROJECT stub's fetch resolves successfully so that projectMiddleware
 * can proceed past the DO stub to reach the project-mismatch guard.
 */
import { vi } from "vitest";
import type { Env } from "../types";

/**
 * 32-byte test HMAC key used across the worker's auth tests.
 * Derivation: btoa("test-hmac-key-this-is-32-bytes!!") base64url-encoded.
 * "test-hmac-key-this-is-32-bytes!!" is exactly 32 ASCII chars.
 */
export const TEST_HMAC_KEY = btoa("test-hmac-key-this-is-32-bytes!!")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

/**
 * Build a minimal, structurally valid Env for auth test apps.
 *
 * @param overrides — shallow-merged onto the base Env shape; pass to
 *   override GITHUB_SESSION_HMAC_KEY (e.g. a wrong key for forgery tests).
 *
 * The PROJECT stub returns a DO stub whose fetch() resolves with a 200 JSON
 * body, allowing projectMiddleware to proceed to the mismatch guard.
 */
export function makeAuthEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    PROJECT: {
      idFromName: vi.fn().mockReturnValue({
        toString: () => "stub-do-id",
      }),
      get: vi.fn().mockReturnValue({
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
          ),
      }),
      idFromString: vi.fn().mockReturnValue({ toString: () => "stub-do-id" }),
      newUniqueId: vi.fn().mockReturnValue({ toString: () => "stub-do-id" }),
    } as unknown as DurableObjectNamespace,
    ARTIFACTS: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
      head: vi.fn().mockResolvedValue(null),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket,
    ANALYTICS: {
      writeDataPoint: vi.fn(),
    } as unknown as AnalyticsEngineDataset,
    GITHUB_SESSION_HMAC_KEY: TEST_HMAC_KEY,
    ...overrides,
  };
}
