import { existsSync, rmSync } from "node:fs";
import type { Cloudflare } from "./cloudflare-client";
import { queryD1 } from "./cloudflare-resources";
import type { AppCredentials } from "./github-app-setup";
import { mintAppJwt } from "./github-app-setup";

export interface TeardownResult {
  ok: boolean;
  message: string;
}

export async function deleteWorker(
  client: Cloudflare,
  accountId: string,
  scriptName: string,
): Promise<TeardownResult> {
  try {
    await client.workers.scripts.delete(scriptName, {
      account_id: accountId,
    });
    return { ok: true, message: `Worker ${scriptName} deleted` };
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return { ok: true, message: `Worker ${scriptName} already gone` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Worker delete failed: ${msg}` };
  }
}

export async function deleteR2Bucket(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<TeardownResult> {
  try {
    for await (const obj of client.r2.buckets.objects.list(bucketName, {
      account_id: accountId,
    })) {
      if (!obj.key) continue;
      try {
        await client.r2.buckets.objects.delete(bucketName, obj.key, {
          account_id: accountId,
        });
      } catch (keyErr) {
        console.error(
          `R2 object delete failed for key ${obj.key}: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`,
        );
      }
    }
    await client.r2.buckets.delete(bucketName, { account_id: accountId });
    return { ok: true, message: `R2 bucket ${bucketName} deleted` };
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return { ok: true, message: `R2 bucket ${bucketName} already gone` };
    }
    return {
      ok: false,
      message: `R2 bucket delete error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function deleteGitHubApp(
  credentials: AppCredentials,
): Promise<TeardownResult> {
  try {
    const jwt = await mintAppJwt(credentials.app_id, credentials.pem);
    const headers = {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${jwt}`,
    };

    // Get App slug for manual deletion link
    const appRes = await fetch("https://api.github.com/app", { headers });
    const appSlug = appRes.ok
      ? ((await appRes.json()) as { slug?: string }).slug
      : null;

    // Delete all installations (API supports this)
    const installRes = await fetch("https://api.github.com/app/installations", {
      headers,
    });
    if (installRes.ok) {
      const installations = (await installRes.json()) as Array<{ id: number }>;
      for (const inst of installations) {
        await fetch(`https://api.github.com/app/installations/${inst.id}`, {
          method: "DELETE",
          headers,
        });
      }
    }

    const settingsUrl = appSlug
      ? `https://github.com/settings/apps/${appSlug}/advanced`
      : "https://github.com/settings/apps";

    return {
      ok: true,
      message: `Installations removed. Delete the App manually at: ${settingsUrl}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `GitHub App error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Delete D1 project records using the Cloudflare SDK.
 * Uses parameterized queries to avoid SQL injection.
 * NOTE: _tokens is deleted LAST so a mid-flight retry can still authenticate.
 */
export async function cleanD1ProjectRecords(
  client: Cloudflare,
  accountId: string,
  databaseId: string,
  slug: string,
): Promise<TeardownResult> {
  try {
    // Delete non-token tables first, _tokens last (retry-authentication safety)
    const tables = [
      "_project_repos",
      "_sessions",
      "_github_app_config",
      "_idempotency",
      "_projects",
      "_tokens", // LAST — token authorizes verification calls; deleting earlier dead-ends a retry
    ];

    for (const table of tables) {
      await client.d1.database.query(databaseId, {
        account_id: accountId,
        sql: `DELETE FROM ${table} WHERE project_id = ?`,
        params: [slug],
      });
    }

    return { ok: true, message: "D1 project records cleaned" };
  } catch (err) {
    return {
      ok: false,
      message: `D1 cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Delete the 5 non-token D1 project tables.
 * Used by `project destroy` to clean D1 BEFORE store verification.
 * _tokens is deleted separately (after verification) via `deleteD1TokenRecord`.
 */
export async function cleanD1NonTokenRecords(
  client: Cloudflare,
  accountId: string,
  databaseId: string,
  slug: string,
): Promise<TeardownResult> {
  try {
    // _projects is NOT deleted here: _tokens has a FK to _projects and is deleted
    // last (it authorizes the verification calls), so _projects must outlive this
    // step and is removed together with _tokens in deleteD1TokenAndProject.
    const tables = [
      "_project_repos",
      "_sessions",
      "_github_app_config",
      "_idempotency",
    ];

    for (const table of tables) {
      await client.d1.database.query(databaseId, {
        account_id: accountId,
        sql: `DELETE FROM ${table} WHERE project_id = ?`,
        params: [slug],
      });
    }

    return { ok: true, message: "D1 non-token records cleaned" };
  } catch (err) {
    return {
      ok: false,
      message: `D1 cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Delete _tokens then _projects for a project from D1 — called LAST after store
 * verification. The token authorizes verification calls, so it (and _projects, which
 * _tokens references via FK) must outlive the verify step. Order matters: _tokens
 * first (child), then _projects (parent), or the FK constraint fails.
 */
export async function deleteD1TokenRecord(
  client: Cloudflare,
  accountId: string,
  databaseId: string,
  slug: string,
): Promise<TeardownResult> {
  try {
    await client.d1.database.query(databaseId, {
      account_id: accountId,
      sql: "DELETE FROM _tokens WHERE project_id = ?",
      params: [slug],
    });
    await client.d1.database.query(databaseId, {
      account_id: accountId,
      sql: "DELETE FROM _projects WHERE project_id = ?",
      params: [slug],
    });
    return { ok: true, message: "Project token and registration deleted" };
  } catch (err) {
    return {
      ok: false,
      message: `_tokens/_projects cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check if an R2 bucket has any remaining objects under the well-known artifact
 * prefixes (produced/, sources/, journal-archive/). Uses per_page=1 probes so
 * only 3 subrequests are needed regardless of bucket size.
 *
 * Returns the first non-empty prefix found, or null if all are empty.
 *
 * Coordination note: this gate is intentionally conservative — it refuses
 * teardown if ANY artifact blob remains under these prefixes. A companion epic
 * (infra-teardown-fails-to-delete-non-empty-r2-bucket) tracks making this
 * failure actionable with a `tila infra r2-gc` repair command.
 */
export async function findNonEmptyR2Prefix(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<string | null> {
  const prefixes = ["produced/", "sources/", "journal-archive/"];
  for (const prefix of prefixes) {
    let found = false;
    for await (const obj of client.r2.buckets.objects.list(bucketName, {
      account_id: accountId,
      prefix,
      per_page: 1,
    })) {
      if (obj.key) {
        found = true;
        break;
      }
    }
    if (found) return prefix;
  }
  return null;
}

export async function deleteD1Database(
  client: Cloudflare,
  accountId: string,
  databaseId: string,
): Promise<TeardownResult> {
  try {
    const rows = await queryD1<{ cnt: number }>(
      client,
      accountId,
      databaseId,
      "SELECT COUNT(*) as cnt FROM _projects",
    );
    const count = rows[0]?.cnt ?? 0;
    if (count > 0) {
      return {
        ok: false,
        message: `D1 database still has ${count} project(s) — skipping deletion`,
      };
    }

    await client.d1.database.delete(databaseId, { account_id: accountId });
    return { ok: true, message: "D1 database tila-global deleted" };
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return { ok: true, message: "D1 database already gone" };
    }
    return {
      ok: false,
      message: `D1 database delete failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function cleanLocalFiles(tilaDir: string): TeardownResult {
  if (!existsSync(join(tilaDir, "config.toml"))) {
    return {
      ok: false,
      message: `Safety check failed: ${tilaDir}/config.toml not found`,
    };
  }
  try {
    rmSync(tilaDir, { recursive: true, force: true });
    return { ok: true, message: ".tila/ directory removed" };
  } catch (err) {
    return {
      ok: false,
      message: `Local cleanup error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Needed for cleanLocalFiles path join
import { join } from "node:path";

/**
 * Result from wipeProjectViaWorker.
 * On success: ok=true + parsed worker response fields.
 * On failure: ok=false + errorClass + errorMessage (never contains the token).
 */
export type WipeProjectResult =
  | {
      ok: true;
      doWiped: boolean;
      journalDeleted: number;
      r2Deleted: number;
      r2Kept: number;
      r2Failed: number;
      r2GcSkipped: boolean;
    }
  | {
      ok: false;
      errorClass: "non-2xx" | "insufficient-scope" | "network-error";
      errorMessage: string;
      status?: number;
    };

/**
 * Call the Worker admin destroy endpoint for a project.
 * NEVER logs the token — error messages contain only HTTP status + error code.
 */
export async function wipeProjectViaWorker(
  workerUrl: string,
  token: string,
  slug: string,
): Promise<WipeProjectResult> {
  return wipeViaEndpoint(`${workerUrl}/projects/${slug}/admin/destroy`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
}

/**
 * Call the infra-owner destroy endpoint for a project by slug, authenticated by
 * the INFRA_ADMIN_TOKEN secret rather than a per-project token. Echoes the
 * slug in X-Confirm-Slug (the Worker rejects a mismatch). Used when an admin
 * destroys a project they have no local .tila/ config for.
 * NEVER logs the token — error messages contain only HTTP status + error code.
 */
export async function wipeProjectViaInfraToken(
  workerUrl: string,
  infraToken: string,
  slug: string,
): Promise<WipeProjectResult> {
  return wipeViaEndpoint(
    `${workerUrl}/_internal/admin/projects/${slug}/destroy`,
    {
      Authorization: `Bearer ${infraToken}`,
      "X-Confirm-Slug": slug,
      "Content-Type": "application/json",
    },
  );
}

/**
 * Shared POST-and-parse core for the two destroy entry points. Both wipe the
 * same way; they differ only in URL and auth headers (per-project token vs
 * infra secret). NEVER include a token in the returned error message.
 */
async function wipeViaEndpoint(
  url: string,
  headers: Record<string, string>,
): Promise<WipeProjectResult> {
  try {
    const res = await fetch(url, { method: "POST", headers });

    if (!res.ok) {
      if (res.status === 403) {
        return {
          ok: false,
          errorClass: "insufficient-scope",
          errorMessage:
            "Project destroy forbidden (HTTP 403): token lacks admin scope",
          status: 403,
        };
      }
      // Try to parse error code but never expose the token
      let errorCode = "unknown";
      try {
        const body = (await res.json()) as { error?: { code?: string } };
        if (body.error?.code) errorCode = body.error.code;
      } catch {
        // ignore parse errors
      }
      return {
        ok: false,
        errorClass: "non-2xx",
        errorMessage: `Project destroy failed (HTTP ${res.status}): ${errorCode}`,
        status: res.status,
      };
    }

    const body = (await res.json()) as {
      ok: boolean;
      doWiped: boolean;
      journalDeleted: number;
      r2Deleted: number;
      r2Kept: number;
      r2Failed: number;
      r2GcSkipped: boolean;
    };

    return {
      ok: true,
      doWiped: body.doWiped ?? false,
      journalDeleted: body.journalDeleted ?? 0,
      r2Deleted: body.r2Deleted ?? 0,
      r2Kept: body.r2Kept ?? 0,
      r2Failed: body.r2Failed ?? 0,
      r2GcSkipped: body.r2GcSkipped ?? false,
    };
  } catch (err) {
    // Network / DNS / timeout errors — never include token in message
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorClass: "network-error",
      errorMessage: `Network error during project destroy: ${msg}`,
    };
  }
}

/**
 * Result from verifyStoresEmpty.
 */
export interface VerifyStoresResult {
  ok: boolean;
  failures: string[];
}

/**
 * Verify all project stores are empty after destroy.
 * - Re-queries D1 for the 5 non-token tables (counts must be 0)
 * - Calls GET /projects/{slug}/admin/store-counts on the Worker and asserts
 *   all `domain` counts are 0 (_schema_history is NOT required zero).
 */
export async function verifyStoresEmpty(opts: {
  cf: Cloudflare;
  accountId: string;
  databaseId: string;
  slug: string;
  workerUrl: string;
  token: string;
}): Promise<VerifyStoresResult> {
  const failures: string[] = [];

  // 1. Re-query D1 child tables for zero rows. _projects and _tokens are excluded:
  // they are the registration rows deleted LAST (after this verification), since the
  // token must still authenticate the store-counts call below and _projects is the
  // FK parent of _tokens.
  const d1Tables = [
    "_project_repos",
    "_sessions",
    "_github_app_config",
    "_idempotency",
  ];

  for (const table of d1Tables) {
    try {
      const page = await opts.cf.d1.database.query(opts.databaseId, {
        account_id: opts.accountId,
        sql: `SELECT COUNT(*) as cnt FROM ${table} WHERE project_id = ?`,
        params: [opts.slug],
      });
      // Handle both SDK envelope shapes: SinglePage iterator or direct {results:[]}
      let cnt = 0;
      if (
        typeof (page as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
        "function"
      ) {
        for await (const queryResult of page as AsyncIterable<{
          results?: Array<{ cnt: number }>;
        }>) {
          cnt = queryResult.results?.[0]?.cnt ?? 0;
          break;
        }
      } else {
        const result = page as { results?: Array<{ cnt: number }> };
        cnt = result.results?.[0]?.cnt ?? 0;
      }
      if (cnt > 0) {
        failures.push(
          `D1 table ${table} still has ${cnt} row(s) for project ${opts.slug}`,
        );
      }
    } catch (err) {
      failures.push(
        `D1 table ${table} query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Call Worker store-counts and assert domain counts all zero
  try {
    const storeUrl = `${opts.workerUrl}/projects/${opts.slug}/admin/store-counts`;
    const res = await fetch(storeUrl, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
      },
    });

    if (!res.ok) {
      failures.push(`store-counts check failed (HTTP ${res.status})`);
    } else {
      const body = (await res.json()) as {
        counts?: {
          domain?: Record<string, number>;
          schemaHistory?: number;
        };
      };
      const domain = body.counts?.domain ?? {};
      // _schema_history is NOT required zero (may carry migration rows post-reconstruction)
      for (const [table, count] of Object.entries(domain)) {
        if (count > 0) {
          failures.push(`DO store ${table} still has ${count} row(s)`);
        }
      }
    }
  } catch (err) {
    failures.push(
      `store-counts network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
