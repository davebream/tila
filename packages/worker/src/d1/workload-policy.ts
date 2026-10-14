import { evaluateGitHubOidcPolicy } from "@tila/core";
import {
  type GitHubActionsContext,
  GitHubActionsContextSchema,
  PROJECT_ROLE_RANK,
  type ProjectRole,
  githubActionsIdentity,
  permissionToRole,
} from "@tila/schemas";
import { trustedActionsIssuer } from "../lib/github-actions-trust";
import {
  ProjectMembershipStore,
  canonicalMembershipPrincipal,
} from "./project-memberships";
import { RepoAllowlistStore } from "./repo-allowlist";

/** No positive cache: current repository policy is authoritative on every use. */
export async function resolveActionsPolicy(
  db: D1Database,
  projectId: string,
  context: GitHubActionsContext,
  trustedIssuers?: string,
) {
  const parsed = GitHubActionsContextSchema.safeParse(context);
  if (!parsed.success) return null;
  const identity = githubActionsIdentity(parsed.data);
  const trusted = trustedActionsIssuer(identity.issuer, trustedIssuers);
  if (!trusted || trusted.host !== identity.host) return null;
  const result = await new RepoAllowlistStore(db).getOidcPolicy(
    projectId,
    identity.host,
    context.repository_id,
  );
  if (
    result.status !== "ok" ||
    !evaluateGitHubOidcPolicy(context.repository_id, result.policy, context)
      .allowed
  )
    return null;
  return {
    role: permissionToRole(result.policy.max_permission),
    repo: result.repo,
  };
}

export async function resolveActionsMembership(
  db: D1Database,
  projectId: string,
  context: GitHubActionsContext,
  issuedRole?: ProjectRole,
  trustedIssuers?: string,
) {
  const current = await resolveActionsPolicy(
    db,
    projectId,
    context,
    trustedIssuers,
  );
  if (!current) return null;
  const principal = canonicalMembershipPrincipal({
    provider: "oidc",
    issuer: githubActionsIdentity(context).issuer,
    subject: context.sub,
  });
  const cap = current.repo.membership_role_cap;
  if (cap !== "viewer" && cap !== "participant" && cap !== "maintainer")
    return null;
  const mirroredRole =
    PROJECT_ROLE_RANK[current.role] <= PROJECT_ROLE_RANK[cap]
      ? current.role
      : cap;
  const membership = await new ProjectMembershipStore(db).resolve(
    projectId,
    principal.principalId,
    current.repo.membership_enabled
      ? { role: mirroredRole, githubRepoId: context.repository_id }
      : null,
  );
  if (!membership) return null;
  let role =
    PROJECT_ROLE_RANK[membership.role] <= PROJECT_ROLE_RANK[current.role]
      ? membership.role
      : current.role;
  if (issuedRole && PROJECT_ROLE_RANK[issuedRole] < PROJECT_ROLE_RANK[role])
    role = issuedRole;
  return {
    ...membership,
    role,
    explicitRole: membership.explicitRole ? role : undefined,
  };
}
