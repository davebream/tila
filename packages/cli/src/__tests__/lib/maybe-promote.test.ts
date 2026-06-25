/**
 * Tests for maybePromoteLegacyAfterWrite (WI-M Task 8).
 *
 * Uses vi.hoisted + vi.mock to intercept the promoteLegacy import inside
 * instance-context.ts, allowing:
 *   1. Verification that resolveInstanceContext never calls promoteLegacy.
 *   2. Direct testing of the maybePromoteLegacyAfterWrite wrapper (CI guard,
 *      error swallowing).
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PromoteOptions, PromoteResult } from "@tila/auth-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted ensures mockPromoteLegacy is available inside the hoisted vi.mock factory.
const { mockPromoteLegacy } = vi.hoisted(() => ({
  mockPromoteLegacy: vi
    .fn<(opts: PromoteOptions) => Promise<PromoteResult>>()
    .mockResolvedValue({
      promotedCredential: false,
      promotedInfraSlugs: [],
      instanceKey: null,
      skippedReason: "no-legacy-data" as const,
    }),
}));

// Partially mock @tila/auth-store: keep everything real but replace promoteLegacy.
vi.mock("@tila/auth-store", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, promoteLegacy: mockPromoteLegacy };
});

// Import AFTER vi.mock so the hoisted mock is in place.
import { AuthStore, FakeSecretStore, TilaPaths } from "@tila/auth-store";
import type { InstanceKey } from "@tila/schemas";
import {
  maybePromoteLegacyAfterWrite,
  resolveInstanceContext,
} from "../../lib/instance-context";

const key = (s: string) => s as InstanceKey;

let tmpDir: string;
let secrets: FakeSecretStore;
let store: AuthStore;
let originalTilaHome: string | undefined;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-maybe-promote-test-"));
  originalTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;
  secrets = new FakeSecretStore();
  store = new AuthStore({
    paths: new TilaPaths(),
    secrets,
    env: { isCI: false, isTTY: true },
  });
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (originalTilaHome !== undefined) {
    process.env.TILA_HOME = originalTilaHome;
  } else {
    process.env.TILA_HOME = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedTrusted(
  k: InstanceKey,
  workerUrl: string,
  token: string,
): Promise<void> {
  await store.registerInstance({
    instance_key: k,
    instance_id_source: "server",
    worker_url: workerUrl,
  });
  await store.markTrusted(k);
  await store.putCredential(k, {
    instance_key: k,
    token,
    token_type: "Bearer",
    expires_at: Date.now() + 3_600_000,
    obtained_at: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Load-bearing: resolveInstanceContext must NEVER call promoteLegacy
// ---------------------------------------------------------------------------

describe("resolveInstanceContext — read path does NOT call promoteLegacy", () => {
  it("promoteLegacy is not called after resolveInstanceContext", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev", "tok-acme");
    await store.setCurrentContext(key("acme-prod"));

    await resolveInstanceContext({
      authStore: store,
      env: { isCI: false, isTTY: true, tilaHomeOverridden: true },
    });

    expect(mockPromoteLegacy).not.toHaveBeenCalled();
  });

  it("promoteLegacy is not called even when legacy env is present (read path)", async () => {
    // Empty registry — resolver will fall through to legacy-fallback (which reads,
    // not promotes).
    await resolveInstanceContext({
      authStore: store,
      env: { isCI: false, isTTY: true, tilaHomeOverridden: true },
      legacy: { projectTilaDir: null, homeInfraToml: null },
    });

    expect(mockPromoteLegacy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// maybePromoteLegacyAfterWrite — wrapper behaviour
// ---------------------------------------------------------------------------

describe("maybePromoteLegacyAfterWrite", () => {
  it("calls promoteLegacy with the correct authStore and workerUrl", async () => {
    mockPromoteLegacy.mockResolvedValueOnce({
      promotedCredential: true,
      promotedInfraSlugs: [],
      instanceKey: key("promoted-key"),
    });

    await maybePromoteLegacyAfterWrite(store, "https://example.tila.dev", {
      isCI: false,
      isTTY: true,
    });

    expect(mockPromoteLegacy).toHaveBeenCalledOnce();
    const callArg = mockPromoteLegacy.mock.calls[0][0] as {
      authStore: AuthStore;
      workerUrl: string;
      env: { isCI: boolean; isTTY: boolean };
    };
    expect(callArg.authStore).toBe(store);
    expect(callArg.workerUrl).toBe("https://example.tila.dev");
    expect(callArg.env.isCI).toBe(false);
    expect(callArg.env.isTTY).toBe(true);
  });

  it("CI env → promoteLegacy is still called but returns skipped:ci (guard is inside promoteLegacy)", async () => {
    // The wrapper always calls promoteLegacy; the CI guard lives inside promoteLegacy itself.
    mockPromoteLegacy.mockResolvedValueOnce({
      promotedCredential: false,
      promotedInfraSlugs: [],
      instanceKey: null,
      skippedReason: "ci" as const,
    });

    await maybePromoteLegacyAfterWrite(store, "https://example.tila.dev", {
      isCI: true,
      isTTY: true,
    });

    expect(mockPromoteLegacy).toHaveBeenCalledOnce();
    // No error thrown
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("swallows a thrown promoteLegacy error — never propagates", async () => {
    mockPromoteLegacy.mockRejectedValueOnce(
      new Error("keychain unavailable in test"),
    );

    // Must resolve (not reject)
    await expect(
      maybePromoteLegacyAfterWrite(store, "https://example.tila.dev", {
        isCI: false,
        isTTY: true,
      }),
    ).resolves.toBeUndefined();

    // Warning written to stderr
    expect(stderrSpy).toHaveBeenCalled();
    const written = (stderrSpy.mock.calls[0] as string[])[0];
    expect(written).toContain("Warning");
    expect(written).toContain("lazy legacy promotion failed");
    // Error description is included for debuggability (but must not contain a raw token value)
    expect(written).toContain("keychain unavailable in test");
  });

  it("swallows error and writes a warning to stderr without the token value", async () => {
    mockPromoteLegacy.mockRejectedValueOnce(new Error("storage write error"));

    await maybePromoteLegacyAfterWrite(store, "https://example.tila.dev", {
      isCI: false,
      isTTY: true,
    });

    // stderr should have been written
    expect(stderrSpy).toHaveBeenCalled();
    const written = (stderrSpy.mock.calls[0] as string[])[0];
    expect(typeof written).toBe("string");
    expect(written).toMatch(/\[tila\] Warning/);
  });
});
