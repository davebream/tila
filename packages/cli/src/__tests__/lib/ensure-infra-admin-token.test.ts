import type { TilaInfraConfig } from "@tila/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// generateRawToken is the RNG seam. Mock it to a fixed value so the
// generate/rotate branches are deterministic, and so we can assert that the
// preserve branch never touches the RNG.
// ---------------------------------------------------------------------------
const FIXED_TOKEN = "tila_fixed_generated_token";

vi.mock("../../lib/provisioning", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/provisioning")>();
  return {
    ...original,
    generateRawToken: vi.fn(() => FIXED_TOKEN),
  };
});

import { ensureInfraAdminToken } from "../../lib/ensure-infra-admin-token";
import { generateRawToken } from "../../lib/provisioning";

const mockGenerateRawToken = vi.mocked(generateRawToken);

function makeInfraConfig(
  overrides: Partial<TilaInfraConfig> = {},
): TilaInfraConfig {
  return {
    account_id: "acct",
    account_name: "Acme",
    d1_database_id: "db",
    ...overrides,
  };
}

describe("ensureInfraAdminToken", () => {
  beforeEach(() => {
    mockGenerateRawToken.mockClear();
  });

  it("generates a new token when none is present in the config", () => {
    const result = ensureInfraAdminToken(makeInfraConfig(), {});

    expect(result).toEqual({ token: FIXED_TOKEN, generated: true });
    expect(mockGenerateRawToken).toHaveBeenCalledTimes(1);
  });

  it("generates a new token when infraConfig is null", () => {
    const result = ensureInfraAdminToken(null, {});

    expect(result).toEqual({ token: FIXED_TOKEN, generated: true });
    expect(mockGenerateRawToken).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing token without calling the RNG seam", () => {
    const existing = "tila_existing_admin_token";
    const result = ensureInfraAdminToken(
      makeInfraConfig({ infra_admin_token: existing }),
      {},
    );

    expect(result).toEqual({ token: existing, generated: false });
    expect(mockGenerateRawToken).not.toHaveBeenCalled();
  });

  it("treats an empty-string token as absent and generates", () => {
    const result = ensureInfraAdminToken(
      makeInfraConfig({ infra_admin_token: "" }),
      {},
    );

    expect(result).toEqual({ token: FIXED_TOKEN, generated: true });
    expect(mockGenerateRawToken).toHaveBeenCalledTimes(1);
  });

  it("regenerates on rotate even when a token is present", () => {
    const result = ensureInfraAdminToken(
      makeInfraConfig({ infra_admin_token: "tila_existing_admin_token" }),
      { rotate: true },
    );

    expect(result).toEqual({ token: FIXED_TOKEN, generated: true });
    expect(mockGenerateRawToken).toHaveBeenCalledTimes(1);
  });
});
