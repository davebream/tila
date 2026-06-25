import { describe, expect, it } from "vitest";
import { SessionPayloadSchema } from "../src/session";

const validPayload = {
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
    const result = SessionPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects issued_at = 0 (clock-unset / garbage)", () => {
    const result = SessionPayloadSchema.safeParse({
      ...validPayload,
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
      ...validPayload,
      issued_at: 999_999_999,
    });
    expect(result.success).toBe(false);
  });

  it("accepts the exact lower bound (1_000_000_000)", () => {
    const result = SessionPayloadSchema.safeParse({
      ...validPayload,
      issued_at: 1_000_000_000,
    });
    expect(result.success).toBe(true);
  });
});
