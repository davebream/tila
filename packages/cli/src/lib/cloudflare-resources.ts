import { join } from "node:path";
import * as p from "@clack/prompts";
import { GITHUB_LOGIN_REGEX } from "@tila/schemas";
import type { Cloudflare } from "./cloudflare-client";
import {
  type MigrationResult,
  applyD1Migrations as runMigrations,
} from "./d1-migrations";
import { D1_DATABASE_NAME } from "./resource-names";

/**
 * Execute a D1 SQL query and return the results array, typed as T[].
 * Handles the SDK's PagePromise envelope so callers don't need unsafe casts.
 */
export async function queryD1<T = Record<string, unknown>>(
  client: Cloudflare,
  accountId: string,
  databaseId: string,
  sql: string,
  params?: string[],
): Promise<T[]> {
  const page = await client.d1.database.query(databaseId, {
    account_id: accountId,
    sql,
    ...(params ? { params } : {}),
  });
  // SDK returns a SinglePage whose iterable yields QueryResult objects.
  // Each QueryResult has a .results array with the actual rows.
  for await (const queryResult of page) {
    return ((queryResult as { results?: unknown[] }).results ?? []) as T[];
  }
  return [];
}

/**
 * Check if tila-global D1 database exists, create if not.
 * Returns the D1 database UUID.
 * Uses direct fetch to avoid the SDK async iterator hanging.
 */
export async function ensureD1Database(
  client: Cloudflare,
  accountId: string,
  apiToken: string,
): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${D1_DATABASE_NAME}`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to list D1 databases (HTTP ${res.status}): ${await res.text().catch(() => "")}`,
    );
  }
  const json = (await res.json()) as {
    result: Array<{ uuid: string; name: string }>;
  };
  const existing = json.result?.find((db) => db.name === D1_DATABASE_NAME);
  if (existing) {
    return existing.uuid;
  }

  const created = await client.d1.database.create({
    account_id: accountId,
    name: D1_DATABASE_NAME,
  });
  if (!created.uuid) {
    p.cancel("Failed to create D1 database: no UUID in response");
    process.exit(1);
  }
  return created.uuid;
}

export async function applyD1Migrations(
  client: Cloudflare,
  accountId: string,
  databaseId: string,
  migrationsDir: string,
): Promise<void> {
  const queryFn = async (
    sql: string,
    params?: (string | number | null)[],
  ): Promise<unknown[]> => {
    const page = await client.d1.database.query(databaseId, {
      account_id: accountId,
      sql,
      params: (params ?? []) as string[],
    });
    for await (const queryResult of page) {
      return (queryResult as { results?: unknown[] }).results ?? [];
    }
    return [];
  };

  const result = await runMigrations({ queryFn, migrationsDir });

  if (result.applied > 0) {
    p.log.info(`  Applied ${result.applied} migration(s).`);
  }
}

/**
 * Create R2 bucket if it doesn't already exist.
 */
export async function ensureR2Bucket(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<void> {
  try {
    await client.r2.buckets.create({
      account_id: accountId,
      name: bucketName,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("already owned")) {
      return;
    }
    p.cancel(`Failed to create R2 bucket: ${msg}`);
    process.exit(1);
  }
}

/**
 * Apply R2 lifecycle rules via the Cloudflare SDK. Non-fatal on failure.
 */
export async function applyR2Lifecycle(
  client: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<void> {
  try {
    await client.r2.buckets.lifecycle.update(bucketName, {
      account_id: accountId,
      rules: [
        {
          id: "backstop-produced-1y",
          conditions: { prefix: "produced/" },
          enabled: true,
          deleteObjectsTransition: {
            condition: { maxAge: 365 * 86400, type: "Age" },
          },
        },
        {
          id: "abort-incomplete-uploads-1d",
          conditions: { prefix: "" },
          enabled: true,
          abortMultipartUploadsTransition: {
            condition: { maxAge: 86400, type: "Age" },
          },
        },
      ],
    });
  } catch {
    // Non-critical — lifecycle rules can be applied later
  }
}

/**
 * Insert token hash and project record into D1 via the Cloudflare SDK.
 * Uses parameterized queries to avoid SQL injection.
 */
export async function insertTokenAndProject(opts: {
  client: Cloudflare;
  accountId: string;
  databaseId: string;
  tokenHash: string;
  slug: string;
}): Promise<void> {
  const createdAt = String(Math.floor(Date.now() / 1000));

  // Insert project record
  await opts.client.d1.database.query(opts.databaseId, {
    account_id: opts.accountId,
    sql: "INSERT OR IGNORE INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES (?, ?, ?, ?, ?)",
    params: [opts.slug, opts.slug, createdAt, "tila-init", opts.accountId],
  });

  // Remove any existing non-revoked "init" token before inserting the new one.
  // The unique index on (project_id, name) is partial (WHERE revoked_at IS NULL),
  // so ON CONFLICT cannot target it — use delete-then-insert instead.
  await opts.client.d1.database.query(opts.databaseId, {
    account_id: opts.accountId,
    sql: "DELETE FROM _tokens WHERE project_id = ? AND name = ? AND revoked_at IS NULL",
    params: [opts.slug, "init"],
  });

  await opts.client.d1.database.query(opts.databaseId, {
    account_id: opts.accountId,
    sql: "INSERT INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    params: [opts.tokenHash, opts.slug, "init", "full", createdAt, "tila-init"],
  });
}

/**
 * Insert or update the GitHub App installation ID for a project in D1 _github_app_config.
 */
export async function insertGithubAppConfig(opts: {
  client: Cloudflare;
  accountId: string;
  databaseId: string;
  projectId: string;
  installationId: number;
}): Promise<void> {
  const createdAt = String(Math.floor(Date.now() / 1000));
  await opts.client.d1.database.query(opts.databaseId, {
    account_id: opts.accountId,
    sql: "INSERT OR REPLACE INTO _github_app_config (project_id, installation_id, created_at, created_by) VALUES (?, ?, ?, ?)",
    params: [
      opts.projectId,
      String(opts.installationId),
      createdAt,
      "tila-init",
    ],
  });
}

/**
 * Resolve the Cloudflare Zone ID for a given hostname.
 *
 * Progressively strips subdomains to find the registrable domain
 * (e.g., tila.acme.com → acme.com) and queries GET /zones?name=<candidate>.
 * Returns the zone ID on match; throws if no zone is found.
 */
export async function resolveZoneId(
  apiToken: string,
  accountId: string,
  hostname: string,
): Promise<string> {
  // Build candidate list by progressively stripping subdomains.
  // Always try from the shortest candidate (bare domain) up to the input.
  // Examples:
  //   "acme.com"       → ["acme.com"]
  //   "tila.acme.com"  → ["acme.com"]
  //   "a.b.acme.com"   → ["b.acme.com", "acme.com"]
  //
  // Strategy: strip one label at a time from the front, collecting suffixes that
  // have at least 2 labels (to avoid trying bare TLDs like "com").
  const parts = hostname.split(".");
  const candidates: string[] = [];
  // i=1 gives parts[1..] (strip first label), stop when only 1 label remains
  for (let i = 1; i <= parts.length - 2; i++) {
    candidates.push(parts.slice(i).join("."));
  }
  // If no candidates were added (hostname is already a bare domain like "acme.com"),
  // use the hostname itself.
  if (candidates.length === 0) {
    candidates.push(hostname);
  }

  for (const candidate of candidates) {
    const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}&account.id=${encodeURIComponent(accountId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(
        `Failed to list zones (HTTP ${res.status}): ${await res.text().catch(() => "")}`,
      );
    }

    const json = (await res.json()) as {
      result: Array<{ id: string; name: string }>;
    };
    if (json.result && json.result.length > 0) {
      return json.result[0].id;
    }
  }

  throw new Error(
    `No Cloudflare zone found for '${hostname}' on this account.\n\nAdd the domain to your Cloudflare account first, or ensure your API token has Zone:Read permission.`,
  );
}

/**
 * Attach a Custom Domain to a Cloudflare Worker via PUT /accounts/:id/workers/domains.
 * 409 Conflict is treated as success (idempotent — domain already attached).
 */
export async function createCustomDomain(opts: {
  apiToken: string;
  accountId: string;
  zoneId: string;
  hostname: string;
  service: string;
  environment?: string;
}): Promise<void> {
  const {
    apiToken,
    accountId,
    zoneId,
    hostname,
    service,
    environment = "production",
  } = opts;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/domains`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ zone_id: zoneId, hostname, service, environment }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (res.status === 409) {
    // Domain already attached — idempotent, treat as success
    return;
  }

  if (!res.ok) {
    throw new Error(
      `Failed to create custom domain (HTTP ${res.status}): ${await res.text().catch(() => "")}`,
    );
  }
}

/**
 * Delete a Cloudflare Pages project. Non-fatal if not found.
 * Retained for teardown of pre-Option-A environments that had a Pages project.
 */
export async function deletePagesProject(
  client: Cloudflare,
  accountId: string,
  projectName: string,
): Promise<void> {
  try {
    await client.pages.projects.delete(projectName, { account_id: accountId });
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 404) return; // Already gone — idempotent
    throw err;
  }
}

/**
 * Set a single Worker secret via the Cloudflare SDK.
 */
export async function setWorkerSecret(
  client: Cloudflare,
  accountId: string,
  scriptName: string,
  name: string,
  value: string,
): Promise<void> {
  await client.workers.scripts.secrets.update(scriptName, {
    account_id: accountId,
    name,
    text: value,
    type: "secret_text",
  });
}

/**
 * Set multiple Worker secrets in parallel via the Cloudflare SDK.
 */
export async function setWorkerSecrets(
  client: Cloudflare,
  accountId: string,
  scriptName: string,
  secrets: Record<string, string>,
): Promise<void> {
  await Promise.all(
    Object.entries(secrets).map(([name, value]) =>
      setWorkerSecret(client, accountId, scriptName, name, value),
    ),
  );
}

/**
 * Delete a single Worker secret idempotently via the Cloudflare SDK.
 *
 * A 404 (not found) is treated as a no-op — the secret is already gone.
 * All other errors are propagated.
 */
export async function deleteWorkerSecret(
  client: Cloudflare,
  accountId: string,
  scriptName: string,
  name: string,
): Promise<void> {
  try {
    await client.workers.scripts.secrets.delete(scriptName, name, {
      account_id: accountId,
    });
  } catch (err) {
    // 404 / not-found: the secret was never set on this script — no-op
    const status =
      (err as { status?: number })?.status ??
      (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return;
    }
    throw err;
  }
}

/**
 * Seed the first admin grant directly into D1 via a parameterized
 * INSERT OR IGNORE INTO _admin_grants. Mirrors insertTokenAndProject's
 * param style (Unix seconds, string params).
 *
 * granted_by_user_id is NULL — marks this as an owner/infra-seeded row.
 * INSERT OR IGNORE against the partial unique index idx_admin_grants_active
 * makes re-running idempotent (no duplicate active row).
 *
 * Rollback note: there is no compensating delete on failure. _projects and
 * _tokens are already inserted before this call. Re-running project create
 * (or using the C5 --token fallback) is the recovery path.
 */
export async function seedFirstAdmin(opts: {
  client: Cloudflare;
  accountId: string;
  databaseId: string;
  slug: string;
  githubUserId: number;
  githubLoginSnapshot?: string;
}): Promise<void> {
  const grantedAt = String(Math.floor(Date.now() / 1000));

  await opts.client.d1.database.query(opts.databaseId, {
    account_id: opts.accountId,
    sql: "INSERT OR IGNORE INTO _admin_grants (project_id, github_host, github_user_id, github_login_snapshot, granted_by_user_id, granted_at) VALUES (?, 'github.com', ?, ?, NULL, ?)",
    params: [
      opts.slug,
      String(opts.githubUserId),
      opts.githubLoginSnapshot ?? null,
      grantedAt,
    ] as string[],
  });
}

/**
 * Resolve a GitHub user id from either a numeric id string or a login name.
 *
 * - All-digits input → passthrough (no fetch).
 * - Login input → validate against GITHUB_LOGIN_REGEX (single source of truth
 *   from @tila/schemas), then GET https://api.github.com/users/{encodeURIComponent(login)}.
 *   Sends GITHUB_TOKEN or GH_TOKEN as a bearer when present (never logged).
 *
 * Error mapping (all non-200/404 → "pass a numeric id" hint):
 *   404              → user not found
 *   401/403/429/5xx  → could not resolve login; pass a numeric id
 *   timeout/network  → could not resolve login; pass a numeric id
 *
 * Security: the base URL is hardcoded — the hostname is never derived from
 * input. Only the regex-validated, encodeURIComponent-encoded login is
 * interpolated into the path.
 */
export async function resolveGithubUserId(
  value: string,
  _token?: string,
): Promise<number> {
  // Numeric id — passthrough, no fetch needed
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  // Validate login format before any outbound call
  if (!GITHUB_LOGIN_REGEX.test(value)) {
    throw new Error(
      `Invalid GitHub login "${value}": not a valid GitHub username (must match /^[a-z\\d](?:[a-z\\d]|-(?=[a-z\\d])){0,38}$/i)`,
    );
  }

  const url = `https://api.github.com/users/${encodeURIComponent(value)}`;

  // GITHUB_TOKEN preferred, GH_TOKEN as fallback — never log the token value
  const githubToken =
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(
      `Could not resolve GitHub login "${value}" (network error or timeout). Re-run with a numeric --admin-github-user id instead of a login, or pass a numeric id directly.`,
    );
  }

  if (response.status === 404) {
    throw new Error(`GitHub user "${value}" not found.`);
  }

  if (!response.ok) {
    throw new Error(
      `Could not resolve GitHub login "${value}" (GitHub API returned HTTP ${response.status}). Re-run with a numeric --admin-github-user id (pass a numeric id instead of a login).`,
    );
  }

  const json = (await response.json()) as { id: number };
  return json.id;
}
