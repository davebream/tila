import { describe, expect, it } from "vitest";
import {
  GitHubSessionPayloadSchema,
  OidcExchangeResponseSchema,
  OidcSessionPayloadSchema,
  SessionPayloadSchema,
} from "../src/session";

// ── Existing issued_at lower-bound tests (WI-C C10) ──────────────────────────
// Note: the discriminated union now requires sub_type; auth.ts default-fills
// "github" for legacy tokens before parsing. Tests here supply sub_type explicitly
// to reflect post-WI-B2 minting (new tokens stamp it; legacy tokens get it
// filled at auth.ts, not here).

const validGitHubPayload = {
  sub_type: "github" as const,
  project_id: "proj-1",
  github_host: "github.com",
  github_repo_id: 99999,
  github_login: "testuser",
  github_user_id: 12345,
  permission: "write" as const,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  issued_at: Math.floor(Date.now() / 1000),
  iss: "tila",
  aud: "tila",
};

describe("SessionPayloadSchema issued_at lower-bound guard (WI-C C10)", () => {
  it("accepts a valid seconds-granularity issued_at", () => {
    const result = SessionPayloadSchema.safeParse(validGitHubPayload);
    expect(result.success).toBe(true);
  });

  it("rejects issued_at = 0 (clock-unset / garbage)", () => {
    const result = SessionPayloadSchema.safeParse({
      ...validGitHubPayload,
      issued_at: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an issued_at below the ~year-2001 floor (1e9)", () => {
    // Defense-in-depth: a token claiming to be issued before 2001 is a clear
    // bug (clock unset, wrong unit shrinking the value, or fabrication). The
    // floor rejects it at parse time rather than letting it reach the
    // subject-revocation comparison.
    const result = SessionPayloadSchema.safeParse({
      ...validGitHubPayload,
      issued_at: 999_999_999,
    });
    expect(result.success).toBe(false);
  });

  it("accepts the exact lower bound (1_000_000_000)", () => {
    const result = SessionPayloadSchema.safeParse({
      ...validGitHubPayload,
      issued_at: 1_000_000_000,
    });
    expect(result.success).toBe(true);
  });
});

// ── New WI-B2 discriminated union tests ───────────────────────────────────────

const validOidcPayload = {
  sub_type: "oidc" as const,
  project_id: "proj-1",
  oidc_issuer: "https://idp.example.com",
  oidc_subject: "user:alice",
  actor_name: "alice",
  permission: "read" as const,
  expires_at: 9999999999,
  issued_at: 1_700_000_000,
};

// ── Case (a): GitHub payload with sub_type:"github" parses successfully ──────

describe("GitHubSessionPayloadSchema", () => {
  it("accepts a full github payload with sub_type:'github'", () => {
    const result = GitHubSessionPayloadSchema.safeParse(validGitHubPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sub_type).toBe("github");
      expect(result.data.github_login).toBe("testuser");
    }
  });

  it("accepts optional fields (iss, aud, jti, instance_id) when present", () => {
    const result = GitHubSessionPayloadSchema.safeParse({
      ...validGitHubPayload,
      jti: "some-jti",
      instance_id: "inst-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when github_login is missing", () => {
    const { github_login, ...rest } = validGitHubPayload;
    const result = GitHubSessionPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ── Case (b): OIDC payload parses and narrows correctly ──────────────────────

describe("OidcSessionPayloadSchema", () => {
  it("accepts a valid oidc payload", () => {
    const result = OidcSessionPayloadSchema.safeParse(validOidcPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sub_type).toBe("oidc");
      expect(result.data.oidc_issuer).toBe("https://idp.example.com");
      expect(result.data.oidc_subject).toBe("user:alice");
      expect(result.data.actor_name).toBe("alice");
    }
  });

  // ── Case (c): OIDC payload missing oidc_issuer fails ─────────────────────
  it("rejects when oidc_issuer is missing", () => {
    const { oidc_issuer, ...rest } = validOidcPayload;
    const result = OidcSessionPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects when oidc_issuer is empty string", () => {
    const result = OidcSessionPayloadSchema.safeParse({
      ...validOidcPayload,
      oidc_issuer: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when oidc_subject is empty string", () => {
    const result = OidcSessionPayloadSchema.safeParse({
      ...validOidcPayload,
      oidc_subject: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when actor_name is empty string", () => {
    const result = OidcSessionPayloadSchema.safeParse({
      ...validOidcPayload,
      actor_name: "",
    });
    expect(result.success).toBe(false);
  });

  // ── Step 3b (security A-4): 256-char oidc_subject must fail ─────────────
  it("rejects an oidc_subject of 256 characters (max is 255)", () => {
    const result = OidcSessionPayloadSchema.safeParse({
      ...validOidcPayload,
      oidc_subject: "a".repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it("accepts an oidc_subject of exactly 255 characters", () => {
    const result = OidcSessionPayloadSchema.safeParse({
      ...validOidcPayload,
      oidc_subject: "a".repeat(255),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an actor_name of 256 characters (max is 255)", () => {
    const result = OidcSessionPayloadSchema.safeParse({
      ...validOidcPayload,
      actor_name: "a".repeat(256),
    });
    expect(result.success).toBe(false);
  });
});

// ── Case (d): cross-shape rejection ──────────────────────────────────────────

describe("SessionPayloadSchema discriminated union", () => {
  it("rejects a github-shaped object with sub_type:'oidc'", () => {
    const result = SessionPayloadSchema.safeParse({
      ...validGitHubPayload,
      sub_type: "oidc",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a github payload (sub_type:'github') through the union", () => {
    const result = SessionPayloadSchema.safeParse(validGitHubPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sub_type).toBe("github");
    }
  });

  it("accepts an oidc payload through the union", () => {
    const result = SessionPayloadSchema.safeParse(validOidcPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sub_type).toBe("oidc");
    }
  });

  it("rejects an oidc-fields object with sub_type:'github' (missing github required fields)", () => {
    // sub_type:"github" demands github_host, github_repo_id, github_login, github_user_id
    const result = SessionPayloadSchema.safeParse({
      sub_type: "github",
      project_id: "proj-1",
      oidc_issuer: "https://idp.example.com",
      oidc_subject: "user:alice",
      actor_name: "alice",
      permission: "read",
      expires_at: 9999999999,
      issued_at: 1_700_000_000,
    });
    expect(result.success).toBe(false);
  });
});

// ── Case (e): OidcExchangeResponseSchema validates correctly ──────────────────

describe("OidcExchangeResponseSchema", () => {
  it("accepts a valid OIDC exchange response", () => {
    const result = OidcExchangeResponseSchema.safeParse({
      ok: true,
      session_token: "tila_s.abc123",
      expires_at: 9999999999,
      project_id: "proj-1",
      oidc_issuer: "https://idp.example.com",
      oidc_subject: "user:alice",
      permission: "read",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.oidc_issuer).toBe("https://idp.example.com");
      expect(result.data.oidc_subject).toBe("user:alice");
    }
  });

  it("rejects when ok is false", () => {
    const result = OidcExchangeResponseSchema.safeParse({
      ok: false,
      session_token: "tila_s.abc123",
      expires_at: 9999999999,
      project_id: "proj-1",
      oidc_issuer: "https://idp.example.com",
      oidc_subject: "user:alice",
      permission: "read",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when oidc_issuer is missing", () => {
    const result = OidcExchangeResponseSchema.safeParse({
      ok: true,
      session_token: "tila_s.abc123",
      expires_at: 9999999999,
      project_id: "proj-1",
      oidc_subject: "user:alice",
      permission: "read",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional instance_id field", () => {
    const result = OidcExchangeResponseSchema.safeParse({
      ok: true,
      session_token: "tila_s.abc123",
      expires_at: 9999999999,
      project_id: "proj-1",
      oidc_issuer: "https://idp.example.com",
      oidc_subject: "user:alice",
      permission: "read",
      instance_id: "inst-1",
    });
    expect(result.success).toBe(true);
  });
});
