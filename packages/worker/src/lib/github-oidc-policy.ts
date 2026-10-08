import type { RepoOidcPolicy } from "@tila/schemas";
import type { OidcClaims } from "./oidc-verify";

export type GitHubOidcPolicyDenialReason =
  | "repository-mismatch"
  | "policy-disabled"
  | "event-mismatch"
  | "subject-mismatch"
  | "context-mismatch"
  | "workflow-mismatch";

export type GitHubOidcPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: GitHubOidcPolicyDenialReason };

/** Case-sensitive, anchored glob matching where only `*` is special. */
export function matchesSubjectPattern(
  pattern: string,
  subject: string,
): boolean {
  let patternIndex = 0;
  let subjectIndex = 0;
  let starIndex = -1;
  let retrySubjectIndex = -1;

  while (subjectIndex < subject.length) {
    if (
      patternIndex < pattern.length &&
      pattern[patternIndex] === subject[subjectIndex]
    ) {
      patternIndex += 1;
      subjectIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      retrySubjectIndex = subjectIndex;
      patternIndex += 1;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      retrySubjectIndex += 1;
      subjectIndex = retrySubjectIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === "*") {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

export function evaluateGitHubOidcPolicy(
  expectedRepositoryId: number,
  policy: RepoOidcPolicy,
  claims: OidcClaims,
): GitHubOidcPolicyDecision {
  if (claims.repository_id !== expectedRepositoryId) {
    return { allowed: false, reason: "repository-mismatch" };
  }
  if (!policy.enabled) {
    return { allowed: false, reason: "policy-disabled" };
  }
  if (!policy.allowed_events.includes(claims.event_name)) {
    return { allowed: false, reason: "event-mismatch" };
  }
  if (
    policy.subject_pattern !== null &&
    !matchesSubjectPattern(policy.subject_pattern, claims.sub)
  ) {
    return { allowed: false, reason: "subject-mismatch" };
  }

  const hasContextPolicy =
    policy.allowed_refs.length > 0 || policy.allowed_environments.length > 0;
  if (
    hasContextPolicy &&
    !(
      (claims.ref !== undefined && policy.allowed_refs.includes(claims.ref)) ||
      (claims.environment !== undefined &&
        policy.allowed_environments.includes(claims.environment))
    )
  ) {
    return { allowed: false, reason: "context-mismatch" };
  }

  if (
    policy.allowed_workflows.length > 0 &&
    (claims.job_workflow_ref === undefined ||
      !policy.allowed_workflows.includes(claims.job_workflow_ref))
  ) {
    return { allowed: false, reason: "workflow-mismatch" };
  }

  return { allowed: true };
}
