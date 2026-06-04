import { describe, expect, it } from "vitest";
import { D1_DATABASE_NAME, R2_BUCKET_NAME } from "../../lib/resource-names";

describe("resource-names", () => {
  it("exports the canonical D1 database name", () => {
    expect(D1_DATABASE_NAME).toBe("tila-global");
  });

  it("exports the canonical R2 bucket name", () => {
    expect(R2_BUCKET_NAME).toBe("tila-artifacts");
  });
});
