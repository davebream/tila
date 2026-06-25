/**
 * Tests for splitInfraConfig — loss-free TilaInfraConfig → InfraRecord (WI-M / Task 2)
 */

import type { TilaInfraConfig } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import { splitInfraConfig } from "./infra-split.js";

const baseConfig: TilaInfraConfig = {
  account_id: "acc-123",
  account_name: "My Account",
  d1_database_id: "db-456",
};

describe("splitInfraConfig — loss-free split (WI-M)", () => {
  it("round-trip preserves r2_bucket_name (F-C regression)", () => {
    const config: TilaInfraConfig = {
      ...baseConfig,
      r2_bucket_name: "my-r2-bucket",
    };
    const record = splitInfraConfig(config);
    expect(record.meta.r2_bucket_name).toBe("my-r2-bucket");
    expect(record.secrets).toBeNull();
  });

  it("preserves all non-secret fields in meta", () => {
    const config: TilaInfraConfig = {
      ...baseConfig,
      worker_url: "https://example.workers.dev",
      r2_bucket_name: "my-bucket",
      pages_project_name: "my-pages",
      github_app: { app_id: 42, installation_id: 99 },
      infra_slug: "prod",
    };
    const record = splitInfraConfig(config);
    expect(record.meta.account_id).toBe("acc-123");
    expect(record.meta.account_name).toBe("My Account");
    expect(record.meta.d1_database_id).toBe("db-456");
    expect(record.meta.worker_url).toBe("https://example.workers.dev");
    expect(record.meta.r2_bucket_name).toBe("my-bucket");
    expect(record.meta.pages_project_name).toBe("my-pages");
    expect(record.meta.github_app).toEqual({ app_id: 42, installation_id: 99 });
    expect(record.meta.infra_slug).toBe("prod");
  });

  it("partitions secret fields to secrets", () => {
    const config: TilaInfraConfig = {
      ...baseConfig,
      hmac_key: "hmac-secret",
      sweep_secret: "sweep-secret",
      infra_admin_token: "admin-token",
    };
    const record = splitInfraConfig(config);
    expect(record.secrets).toEqual({
      hmac_key: "hmac-secret",
      sweep_secret: "sweep-secret",
      infra_admin_token: "admin-token",
    });
    // Secrets must NOT appear in meta
    expect((record.meta as Record<string, unknown>).hmac_key).toBeUndefined();
    expect(
      (record.meta as Record<string, unknown>).sweep_secret,
    ).toBeUndefined();
    expect(
      (record.meta as Record<string, unknown>).infra_admin_token,
    ).toBeUndefined();
  });

  it("returns secrets: null when no secret fields present", () => {
    const record = splitInfraConfig(baseConfig);
    expect(record.secrets).toBeNull();
  });

  it("returns secrets: null when secret fields are all undefined", () => {
    const config: TilaInfraConfig = {
      ...baseConfig,
      hmac_key: undefined,
      sweep_secret: undefined,
      infra_admin_token: undefined,
    };
    const record = splitInfraConfig(config);
    expect(record.secrets).toBeNull();
  });

  it("throws on any unmapped non-secret field (cast past Zod type)", () => {
    // Simulate future schema drift: a new field that was added to TilaInfraConfig
    // but not yet mapped in splitInfraConfig
    expect(() =>
      splitInfraConfig({
        ...baseConfig,
        bogus_field: "x",
      } as unknown as TilaInfraConfig),
    ).toThrow(/unmapped infra field: bogus_field/);
  });
});
