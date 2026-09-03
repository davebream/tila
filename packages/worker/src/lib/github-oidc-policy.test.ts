import type { RepoOidcPolicy } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import {
  evaluateGitHubOidcPolicy,
  matchesSubjectPattern,
} from "./github-oidc-policy";
import type { OidcClaims } from "./oidc-verify";

const policy: RepoOidcPolicy = {
  enabled: true,
  max_permission: "read",
  subject_pattern: "repo:acme/widgets:*",
  allowed_events: ["push"],
  allowed_refs: ["refs/heads/main"],
  allowed_environments: ["production"],
  allowed_workflows: [],
};

const claims = {
  repository_id: 123,
  event_name: "push",
  sub: "repo:acme/widgets:ref:refs/heads/main",
  ref: "refs/heads/main",
  actor_id: 7,
} as OidcClaims;

describe("matchesSubjectPattern", () => {
  it("matches the full string with only star treated as a wildcard", () => {
    expect(matchesSubjectPattern("repo:acme/widgets:*", claims.sub)).toBe(true);
    expect(matchesSubjectPattern("repo:acme/*:ref:*", claims.sub)).toBe(true);
    expect(matchesSubjectPattern("repo:acme/widgets", claims.sub)).toBe(false);
    expect(matchesSubjectPattern("repo:acme/widgets:?", claims.sub)).toBe(
      false,
    );
    expect(matchesSubjectPattern("Repo:acme/widgets:*", claims.sub)).toBe(
      false,
    );
  });
});

describe("evaluateGitHubOidcPolicy", () => {
  it("allows an exact push/branch policy match", () => {
    expect(evaluateGitHubOidcPolicy(123, policy, claims)).toEqual({
      allowed: true,
    });
  });

  it("denies repository, disabled, event, and subject mismatches", () => {
    expect(evaluateGitHubOidcPolicy(999, policy, claims)).toMatchObject({
      reason: "repository-mismatch",
    });
    expect(
      evaluateGitHubOidcPolicy(123, { ...policy, enabled: false }, claims),
    ).toMatchObject({ reason: "policy-disabled" });
    expect(
      evaluateGitHubOidcPolicy(123, policy, {
        ...claims,
        event_name: "pull_request",
      }),
    ).toMatchObject({ reason: "event-mismatch" });
    expect(
      evaluateGitHubOidcPolicy(123, policy, {
        ...claims,
        sub: "repo:other/repo:ref:refs/heads/main",
      }),
    ).toMatchObject({ reason: "subject-mismatch" });
  });

  it("allows pull requests only when the exact event is configured", () => {
    expect(
      evaluateGitHubOidcPolicy(
        123,
        { ...policy, allowed_events: ["pull_request"] },
        { ...claims, event_name: "pull_request" },
      ),
    ).toEqual({ allowed: true });
    expect(
      evaluateGitHubOidcPolicy(
        123,
        { ...policy, allowed_events: ["pull_request"] },
        { ...claims, event_name: "pull_request_target" },
      ),
    ).toMatchObject({ reason: "event-mismatch" });
  });

  it("accepts an exact tag or environment through ref-or-environment context", () => {
    expect(
      evaluateGitHubOidcPolicy(
        123,
        { ...policy, allowed_refs: ["refs/tags/v1"] },
        { ...claims, ref: "refs/tags/v1" },
      ),
    ).toEqual({ allowed: true });
    expect(
      evaluateGitHubOidcPolicy(123, policy, {
        ...claims,
        ref: "refs/heads/feature",
        environment: "production",
      }),
    ).toEqual({ allowed: true });
  });

  it("denies a missing or unmatched context claim", () => {
    expect(
      evaluateGitHubOidcPolicy(123, policy, {
        ...claims,
        ref: undefined,
        environment: undefined,
      }),
    ).toMatchObject({ reason: "context-mismatch" });
  });

  it("pins a reusable workflow independently of the calling branch", () => {
    const allowedWorkflow =
      "acme/automation/.github/workflows/deploy.yml@refs/heads/main";
    const workflowPolicy = {
      ...policy,
      allowed_refs: [],
      allowed_environments: [],
      allowed_workflows: [allowedWorkflow],
    };
    expect(
      evaluateGitHubOidcPolicy(123, workflowPolicy, {
        ...claims,
        ref: "refs/heads/feature",
        job_workflow_ref: allowedWorkflow,
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateGitHubOidcPolicy(123, workflowPolicy, {
        ...claims,
        job_workflow_ref: undefined,
      }),
    ).toMatchObject({ reason: "workflow-mismatch" });
  });

  it("denies a fork-origin pull request under the default push-only policy", () => {
    expect(
      evaluateGitHubOidcPolicy(123, policy, {
        ...claims,
        event_name: "pull_request",
        sub: "repo:acme/widgets:pull_request",
        ref: "refs/pull/42/merge",
      }),
    ).toMatchObject({ reason: "event-mismatch" });
  });
});
