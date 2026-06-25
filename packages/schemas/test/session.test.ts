import { describe, expect, it } from "vitest";
import {
  GitHubSessionPayloadSchema,
  OidcExchangeResponseSchema,
  OidcSessionPayloadSchema,
  SessionPayloadSchema,
} from "../src/session";

const baseGithub = {
  sub_type: "github" as const,
  project_id: "proj-1",
  github_host: "github.com",
  github_repo_id: 42,
  github_login: "octocat",
  github_user_id: 7,
  permission: "write" as const,
  expires_at: 1_700_000_000,
  issued_at: 1_699_999_000,
};

const baseOidc = {
  sub_type: "oidc" as const,
  project_id: "proj-1",
  oidc_issuer: "https://idp.example.com",
  oidc_subject: "workload-123",
  actor_name: "workload-123",
  permission: "read" as const,
  expires_at: 1_700_000_000,
  issued_at: 1_699_999_000,
};

describe("SessionPayloadSchema discriminated union", () => {
  it("accepts a github payload (with sub_type) and narrows it", () => {
    const parsed = SessionPayloadSchema.safeParse(baseGithub);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.sub_type === "github") {
      expect(parsed.data.github_repo_id).toBe(42);
    }
  });

  it("accepts a legacy github payload once sub_type is default-filled to github", () => {
    // The auth middleware default-fills an absent sub_type to "github" before
    // parsing; emulate that here (legacy token had no sub_type field).
    const { sub_type: _omit, ...legacy } = baseGithub;
    const parsed = GitHubSessionPayloadSchema.safeParse({
      sub_type: "github",
      ...legacy,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an oidc payload and narrows it", () => {
    const parsed = SessionPayloadSchema.safeParse(baseOidc);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.sub_type === "oidc") {
      expect(parsed.data.oidc_subject).toBe("workload-123");
      expect("github_repo_id" in parsed.data).toBe(false);
    }
  });

  it("rejects an oidc payload missing oidc_issuer", () => {
    const { oidc_issuer: _omit, ...rest } = baseOidc;
    expect(SessionPayloadSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a github-shaped object tagged sub_type:oidc (cross-shape)", () => {
    const parsed = SessionPayloadSchema.safeParse({
      ...baseGithub,
      sub_type: "oidc",
    });
    expect(parsed.success).toBe(false);
  });

  it("carries optional jti/instance_id on the shared base", () => {
    const parsed = SessionPayloadSchema.safeParse({
      ...baseOidc,
      jti: "nonce",
      instance_id: "inst-1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.instance_id).toBe("inst-1");
    }
  });

  it("rejects an oidc_subject longer than 255 chars (security cap)", () => {
    const parsed = OidcSessionPayloadSchema.safeParse({
      ...baseOidc,
      oidc_subject: "x".repeat(256),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("OidcExchangeResponseSchema", () => {
  it("validates the success response shape", () => {
    const parsed = OidcExchangeResponseSchema.safeParse({
      ok: true,
      session_token: "tila_s.aaa.bbb.ccc",
      expires_at: 1_700_000_000,
      project_id: "proj-1",
      oidc_issuer: "https://idp.example.com",
      oidc_subject: "workload-123",
      permission: "read",
    });
    expect(parsed.success).toBe(true);
  });
});
