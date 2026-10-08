import { describe, expect, it } from "vitest";
import { RepoOidcPolicySchema } from "../src/api";

const disabledPolicy = {
  enabled: false,
  max_permission: "read" as const,
  subject_pattern: null,
  allowed_events: [],
  allowed_refs: [],
  allowed_environments: [],
  allowed_workflows: [],
};

describe("RepoOidcPolicySchema", () => {
  it("accepts a complete disabled policy with no allowed events", () => {
    expect(RepoOidcPolicySchema.parse(disabledPolicy)).toEqual(disabledPolicy);
  });

  it("requires an enabled policy to allow at least one event", () => {
    expect(
      RepoOidcPolicySchema.safeParse({ ...disabledPolicy, enabled: true })
        .success,
    ).toBe(false);
  });

  it("rejects duplicate, empty, oversized, and over-count conditions", () => {
    expect(
      RepoOidcPolicySchema.safeParse({
        ...disabledPolicy,
        allowed_refs: ["refs/heads/main", "refs/heads/main"],
      }).success,
    ).toBe(false);
    expect(
      RepoOidcPolicySchema.safeParse({ ...disabledPolicy, allowed_refs: [""] })
        .success,
    ).toBe(false);
    expect(
      RepoOidcPolicySchema.safeParse({
        ...disabledPolicy,
        allowed_refs: ["x".repeat(513)],
      }).success,
    ).toBe(false);
    expect(
      RepoOidcPolicySchema.safeParse({
        ...disabledPolicy,
        allowed_refs: Array.from({ length: 51 }, (_, index) => `ref-${index}`),
      }).success,
    ).toBe(false);
  });

  it("requires every field for full-replacement PUT semantics", () => {
    const { allowed_workflows: _, ...incomplete } = disabledPolicy;
    expect(RepoOidcPolicySchema.safeParse(incomplete).success).toBe(false);
  });
});
