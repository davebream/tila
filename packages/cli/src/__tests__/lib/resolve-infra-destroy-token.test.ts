import type { TilaInfraConfig } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import { resolveInfraDestroyToken } from "../../lib/resolve-destroy-plan";

const baseInfra = {
  account_id: "a",
  account_name: "A",
  d1_database_id: "db",
} as TilaInfraConfig;

describe("resolveInfraDestroyToken", () => {
  it("prefers the environment variable over infra.toml", () => {
    const token = resolveInfraDestroyToken(
      { ...baseInfra, infra_destroy_token: "from-file" },
      "from-env",
    );
    expect(token).toBe("from-env");
  });

  it("falls back to infra.toml when env is unset", () => {
    const token = resolveInfraDestroyToken(
      { ...baseInfra, infra_destroy_token: "from-file" },
      undefined,
    );
    expect(token).toBe("from-file");
  });

  it("treats a blank/whitespace env value as unset", () => {
    const token = resolveInfraDestroyToken(
      { ...baseInfra, infra_destroy_token: "from-file" },
      "   ",
    );
    expect(token).toBe("from-file");
  });

  it("returns null when neither env nor infra.toml provides a token", () => {
    expect(resolveInfraDestroyToken(baseInfra, undefined)).toBeNull();
    expect(resolveInfraDestroyToken(null, undefined)).toBeNull();
  });
});
