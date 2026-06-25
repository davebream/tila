/**
 * Tests for PerSlugInfraMetaSchema — r2_bucket_name field (WI-M / Task 1)
 */

import { describe, expect, it } from "vitest";
import { PerSlugInfraMetaSchema } from "../src/infra-config";

const baseRequired = {
  account_id: "acc-123",
  account_name: "My Account",
  d1_database_id: "db-456",
};

describe("PerSlugInfraMetaSchema — r2_bucket_name (WI-M)", () => {
  it("accepts and preserves r2_bucket_name", () => {
    const parsed = PerSlugInfraMetaSchema.parse({
      ...baseRequired,
      r2_bucket_name: "my-bucket",
    });
    expect(parsed.r2_bucket_name).toBe("my-bucket");
  });

  it("accepts without r2_bucket_name (optional)", () => {
    const parsed = PerSlugInfraMetaSchema.parse(baseRequired);
    expect(parsed.r2_bucket_name).toBeUndefined();
  });

  it("round-trips r2_bucket_name through parse", () => {
    const input = {
      ...baseRequired,
      worker_url: "https://my-worker.example.workers.dev",
      r2_bucket_name: "tila-artifacts",
      infra_slug: "prod",
    };
    const parsed = PerSlugInfraMetaSchema.parse(input);
    expect(parsed.r2_bucket_name).toBe("tila-artifacts");
    expect(parsed.worker_url).toBe("https://my-worker.example.workers.dev");
    expect(parsed.infra_slug).toBe("prod");
  });
});
