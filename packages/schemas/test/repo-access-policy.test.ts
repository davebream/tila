import { describe, expect, it } from "vitest";
import { RepoAccessPolicySchema, RepoRegisterRequestSchema } from "../src/api";

describe("repository access policy schemas", () => {
  it("defaults registration to write thresholds and a write cap", () => {
    expect(
      RepoRegisterRequestSchema.parse({ owner: "acme", repo: "app" }),
    ).toMatchObject({
      min_read_permission: "write",
      min_write_permission: "write",
      max_permission: "write",
    });
  });

  it("accepts GitHub collaborator tiers and Tila role caps", () => {
    expect(
      RepoAccessPolicySchema.parse({
        min_read_permission: "triage",
        min_write_permission: "maintain",
        max_permission: "admin",
      }),
    ).toEqual({
      min_read_permission: "triage",
      min_write_permission: "maintain",
      max_permission: "admin",
      membership_enabled: true,
      membership_role_cap: "participant",
    });
  });

  it("rejects inverted thresholds and unknown values", () => {
    expect(
      RepoAccessPolicySchema.safeParse({
        min_read_permission: "admin",
        min_write_permission: "write",
        max_permission: "admin",
      }).success,
    ).toBe(false);
    expect(
      RepoAccessPolicySchema.safeParse({
        min_read_permission: "pull",
        min_write_permission: "push",
        max_permission: "owner",
      }).success,
    ).toBe(false);
  });
});
