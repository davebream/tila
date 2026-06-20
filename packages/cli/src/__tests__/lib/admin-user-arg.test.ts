import { describe, expect, it } from "vitest";
import type { AdminListRow } from "../../lib/admin-user-arg";
import { parseGrantArg, resolveRevokeArg } from "../../lib/admin-user-arg";

describe("parseGrantArg", () => {
  it("all-digits → github_user_id", () => {
    const result = parseGrantArg("583231");
    expect(result).toEqual({ github_user_id: 583231 });
  });

  it("all-digits (leading zero not treated as login) → github_user_id", () => {
    const result = parseGrantArg("007");
    expect(result).toEqual({ github_user_id: 7 });
  });

  it("login string → login body", () => {
    const result = parseGrantArg("octocat");
    expect(result).toEqual({ login: "octocat" });
  });

  it("login with hyphens → login body", () => {
    const result = parseGrantArg("some-user-name");
    expect(result).toEqual({ login: "some-user-name" });
  });
});

describe("resolveRevokeArg — numeric id", () => {
  it("all-digits input → returns id directly, no snapshot needed", () => {
    const result = resolveRevokeArg("1234", null);
    expect(result).toEqual({ id: 1234 });
  });

  it("numeric id with snapshot provided → still uses numeric id", () => {
    const snapshot: AdminListRow[] = [
      { github_user_id: 9999, login: "other", granted_by: null, granted_at: 0 },
    ];
    const result = resolveRevokeArg("1234", snapshot);
    expect(result).toEqual({ id: 1234 });
  });
});

describe("resolveRevokeArg — login with snapshot", () => {
  const snapshot: AdminListRow[] = [
    {
      github_user_id: 1001,
      login: "alice",
      granted_by: null,
      granted_at: 1700000000,
    },
    {
      github_user_id: 1002,
      login: null, // numeric-id granted, no snapshot
      granted_by: 1001,
      granted_at: 1700000001,
    },
    {
      github_user_id: 1003,
      login: "charlie",
      granted_by: 1001,
      granted_at: 1700000002,
    },
  ];

  it("login found with matching snapshot → returns id", () => {
    const result = resolveRevokeArg("alice", snapshot);
    expect(result).toEqual({ id: 1001 });
  });

  it("login lookup is case-insensitive", () => {
    const result = resolveRevokeArg("Alice", snapshot);
    expect(result).toEqual({ id: 1001 });
  });

  it("login not found in roster → returns error", () => {
    const result = resolveRevokeArg("unknownuser", snapshot);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/not found/i);
    expect((result as { error: string }).error).toMatch(/numeric/i);
  });

  it("row exists but login snapshot is null → returns error pointing at numeric id", () => {
    // Row 1002 has null login — revoke by the user id 1002 via numeric should work,
    // but revoke by any login that would match their null snapshot cannot succeed.
    // We test that a login NOT in the snapshot (could be user 1002's real login)
    // produces an actionable error.
    const result = resolveRevokeArg("bob", snapshot);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/not found/i);
  });
});

describe("resolveRevokeArg — null snapshot", () => {
  it("login arg with null snapshot → error mentioning numeric id", () => {
    const result = resolveRevokeArg("alice", null);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/numeric/i);
    expect((result as { error: string }).error).toMatch(/unavailable/i);
  });
});
