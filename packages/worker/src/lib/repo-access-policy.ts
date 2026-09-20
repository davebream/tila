import type { RepoAllowlistRow } from "@tila/backend-d1";
import {
  GitHubRepositoryPermissionSchema,
  RepoAccessPolicySchema,
  type SessionPermission,
} from "@tila/schemas";
import {
  PERMISSION_HIERARCHY,
  normalizeGitHubPermission,
} from "./github-permission";

const TILA_PERMISSION_RANK: Record<SessionPermission, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

export interface RepositoryAccessDecision {
  repo: RepoAllowlistRow;
  githubPermission: string;
  permission: SessionPermission;
}

/**
 * Evaluate one repository link. Invalid stored policy and unknown GitHub
 * permission values fail closed for this link.
 */
export function evaluateRepositoryAccess(
  repo: RepoAllowlistRow,
  actualPermission: string | null,
): RepositoryAccessDecision | null {
  const actual = GitHubRepositoryPermissionSchema.safeParse(actualPermission);
  const policy = RepoAccessPolicySchema.safeParse({
    min_read_permission: repo.min_read_permission,
    min_write_permission: repo.min_write_permission,
    max_permission: repo.max_permission,
    // Rows read during a rolling deployment, and older test fixtures, predate
    // the adapter columns. Existing links migrate enabled with a cap matching
    // their previous maximum permission.
    membership_enabled: repo.membership_enabled !== 0,
    membership_role_cap:
      repo.membership_role_cap ??
      (repo.max_permission === "admin"
        ? "maintainer"
        : repo.max_permission === "read"
          ? "viewer"
          : "participant"),
  });
  if (!actual.success || !policy.success) return null;

  const actualRank = PERMISSION_HIERARCHY[actual.data];
  if (actualRank < PERMISSION_HIERARCHY[policy.data.min_read_permission]) {
    return null;
  }

  let permission: SessionPermission = "read";
  if (actualRank >= PERMISSION_HIERARCHY[policy.data.min_write_permission]) {
    const mappedPermission = normalizeGitHubPermission(actual.data);
    permission =
      TILA_PERMISSION_RANK[mappedPermission] <=
      TILA_PERMISSION_RANK[policy.data.max_permission]
        ? mappedPermission
        : policy.data.max_permission;
  }

  return {
    repo,
    githubPermission: actual.data,
    permission,
  };
}

/**
 * Evaluate every enabled repository link and select the strongest effective
 * Tila permission. Equal permissions are resolved by the lowest repository ID,
 * making the result independent of database row order.
 */
export async function resolveRepositoryAccess(
  repos: RepoAllowlistRow[],
  getPermission: (repo: RepoAllowlistRow) => Promise<string | null>,
): Promise<RepositoryAccessDecision | null> {
  let best: RepositoryAccessDecision | null = null;

  for (const repo of repos) {
    const candidate = evaluateRepositoryAccess(repo, await getPermission(repo));
    if (!candidate) continue;

    if (
      !best ||
      TILA_PERMISSION_RANK[candidate.permission] >
        TILA_PERMISSION_RANK[best.permission] ||
      (candidate.permission === best.permission &&
        candidate.repo.github_repo_id < best.repo.github_repo_id)
    ) {
      best = candidate;
    }
  }

  return best;
}

export function permissionMeetsRequirement(
  permission: SessionPermission,
  required: SessionPermission,
): boolean {
  return TILA_PERMISSION_RANK[permission] >= TILA_PERMISSION_RANK[required];
}
