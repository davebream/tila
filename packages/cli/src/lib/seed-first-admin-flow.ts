import type { Cloudflare } from "./cloudflare-client";
import { resolveGithubUserId, seedFirstAdmin } from "./cloudflare-resources";

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
 * row in D1 via seedFirstAdmin.
 *
 * Returns { seeded: true, githubUserId, login? } on success, or
 * { seeded: false, error } on any failure (resolution or D1 write).
 *
 * This is the testable seam so that create.ts stays thin.
 */
export async function runFirstAdminSeed(opts: {
  flag: string;
  client: Cloudflare;
  accountId: string;
  databaseId: string;
  slug: string;
}): Promise<FirstAdminSeedResult> {
  const { flag, client, accountId, databaseId, slug } = opts;

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
    await seedFirstAdmin({
      client,
      accountId,
      databaseId,
      slug,
      githubUserId,
      githubLoginSnapshot: isLogin ? flag : undefined,
    });
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
