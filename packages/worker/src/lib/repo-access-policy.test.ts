import type { RepoAllowlistRow } from "@tila/backend-d1";
import { describe, expect, it } from "vitest";
import {
  evaluateRepositoryAccess,
  resolveRepositoryAccess,
} from "./repo-access-policy";

function repo(overrides: Partial<RepoAllowlistRow> = {}): RepoAllowlistRow {
  return {
    project_id: "project-1",
    github_host: "github.com",
    github_owner: "acme",
    github_repo: "app",
    github_repo_id: 1,
    min_read_permission: "read",
    min_write_permission: "write",
    max_permission: "write",
    oidc_permission: "write",
    oidc_enabled: 0,
    oidc_max_permission: "read",
    oidc_subject_pattern: null,
    oidc_allowed_events: "[]",
    oidc_allowed_refs: "[]",
    oidc_allowed_environments: "[]",
    oidc_allowed_workflows: "[]",
    enabled: 1,
    created_at: 1,
    created_by: "admin",
    ...overrides,
  };
}

describe("repository access policy", () => {
  it("denies admission below the read threshold", () => {
    expect(
      evaluateRepositoryAccess(repo({ min_read_permission: "write" }), "read"),
    ).toBeNull();
  });

  it("admits read without granting write membership", () => {
    expect(
      evaluateRepositoryAccess(
        repo({ min_write_permission: "maintain", max_permission: "admin" }),
        "write",
      )?.permission,
    ).toBe("read");
  });

  it.each([
    ["read", "read"],
    ["write", "write"],
    ["admin", "admin"],
  ] as const)("caps an admin collaborator at %s", (cap, expected) => {
    expect(
      evaluateRepositoryAccess(repo({ max_permission: cap }), "admin")
        ?.permission,
    ).toBe(expected);
  });

  it("fails closed for unknown permissions and malformed stored policy", () => {
    expect(evaluateRepositoryAccess(repo(), "owner")).toBeNull();
    expect(
      evaluateRepositoryAccess(repo({ max_permission: "owner" }), "admin"),
    ).toBeNull();
    expect(
      evaluateRepositoryAccess(
        repo({
          min_read_permission: "admin",
          min_write_permission: "write",
        }),
        "admin",
      ),
    ).toBeNull();
  });

  it("selects the strongest bounded role regardless of repository order", async () => {
    const readRepo = repo({ github_repo_id: 30, max_permission: "read" });
    const writeRepo = repo({ github_repo_id: 40, max_permission: "write" });
    const permission = async () => "admin";

    const forward = await resolveRepositoryAccess(
      [readRepo, writeRepo],
      permission,
    );
    const reverse = await resolveRepositoryAccess(
      [writeRepo, readRepo],
      permission,
    );

    expect(forward?.repo.github_repo_id).toBe(40);
    expect(reverse?.repo.github_repo_id).toBe(40);
    expect(forward?.permission).toBe("write");
    expect(reverse?.permission).toBe("write");
  });

  it("breaks equal-role ties by the lowest repository id", async () => {
    const higherId = repo({ github_repo_id: 20 });
    const lowerId = repo({ github_repo_id: 10 });

    const result = await resolveRepositoryAccess(
      [higherId, lowerId],
      async () => "write",
    );

    expect(result?.repo.github_repo_id).toBe(10);
  });
});
