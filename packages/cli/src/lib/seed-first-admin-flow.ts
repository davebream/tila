import { MembershipGrantResponseSchema } from "@tila/schemas";
import type { TilaClient } from "tila-sdk";
import { resolveGithubUserId } from "./cloudflare-resources";

/**
 * Result from runFirstAdminSeed.
 */
export interface FirstAdminSeedResult {
  seeded: boolean;
  githubUserId?: number;
  /** The login that was resolved (when the input was a login string, not an id) */
  login?: string;
  error?: string;
}

/**
 * Outcome from applySeedOutcome — a pure mapping for the caller to act on.
 */
export interface SeedOutcomeDecision {
  exitCode: 0 | 1;
  /** JSON payload to include in the success/failure response (when --json mode). */
  json?: Record<string, unknown>;
  /** Human-readable message for interactive mode failure. */
  message?: string;
}

/**
 * Resolve login-or-id to a numeric GitHub user id, then seed the first admin
 * owner membership through the Worker, including its canonical audit event.
 *
 * Returns { seeded: true, githubUserId, login? } on success, or
 * { seeded: false, error } on any failure (resolution, API or persisted role).
 *
 * This is the testable seam so that create.ts stays thin.
 */
export async function runFirstAdminSeed(opts: {
  flag: string;
  client: Pick<TilaClient, "post">;
  slug: string;
}): Promise<FirstAdminSeedResult> {
  const { flag, client, slug } = opts;

  // Determine if flag looks like a login (non-numeric)
  const isLogin = !/^\d+$/.test(flag);

  let githubUserId: number;
  try {
    githubUserId = await resolveGithubUserId(flag);
  } catch (err) {
    return {
      seeded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const result = await client.post(
      `/projects/${encodeURIComponent(slug)}/memberships`,
      {
        principal: {
          provider: "github",
          host: "github.com",
          user_id: githubUserId,
          ...(isLogin ? { login: flag } : {}),
        },
        subject_kind: "human",
        role: "owner",
      },
      { schema: MembershipGrantResponseSchema, validate: true },
    );
    const membership = result.membership;
    if (
      membership.project_id !== slug ||
      membership.principal_id !== `github:github.com:${githubUserId}` ||
      membership.provider !== "github" ||
      membership.identity_host !== "github.com" ||
      membership.subject_id !== String(githubUserId) ||
      membership.subject_kind !== "human" ||
      membership.revoked_at !== null
    ) {
      throw new Error(
        "Worker returned a membership that does not match the requested first admin",
      );
    }
    if (membership.role !== "owner") {
      throw new Error(
        `GitHub user ${githubUserId} already has role '${membership.role}'. Explicitly update that membership to owner before retrying; project creation leaves the current role unchanged.`,
      );
    }
  } catch (err) {
    return {
      seeded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    seeded: true,
    githubUserId,
    ...(isLogin ? { login: flag } : {}),
  };
}

/**
 * Pure mapping from seed result to exit decision.
 *
 * seeded:false ⇒ exitCode 1 + first_admin_seeded:false (+ error code in JSON)
 * seeded:true  ⇒ exitCode 0 + first_admin_seeded:true (+ first_admin in JSON)
 *
 * The failure-path message MUST point at the D1-token / --token fallback (C5),
 * NOT at `tila admin grant` — that command itself requires an admin to exist.
 */
export function applySeedOutcome(
  result: FirstAdminSeedResult,
  opts: { json: boolean },
): SeedOutcomeDecision {
  if (!result.seeded) {
    return {
      exitCode: 1,
      json: {
        first_admin_seeded: false,
        error: result.error ?? "unknown error",
        code: "ADMIN_SEED_FAILED",
      },
      message: `Failed to seed first admin: ${result.error ?? "unknown error"}.\n\nRemediation: re-run with a numeric GitHub user id (--admin-github-user <id>), or use the D1-token fallback:\n  tila admin grant <user> --token <your-d1-init-token>`,
    };
  }

  return {
    exitCode: 0,
    json: {
      first_admin_seeded: true,
      first_admin: {
        github_user_id: result.githubUserId,
        ...(result.login !== undefined ? { login: result.login } : {}),
      },
    },
  };
}
