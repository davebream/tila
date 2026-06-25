import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// --- _projects ---
export const projects = sqliteTable("_projects", {
  project_id: text("project_id").primaryKey(),
  display_name: text("display_name"),
  created_at: integer("created_at").notNull(),
  created_by: text("created_by").notNull(),
  cloudflare_account_id: text("cloudflare_account_id").notNull(),
  schema_version: integer("schema_version").notNull().default(1),
  archived: integer("archived").notNull().default(0),
  repo_admin_auto_admin: integer("repo_admin_auto_admin").notNull().default(0),
});

// --- _tokens ---
export const tokens = sqliteTable(
  "_tokens",
  {
    token_hash: text("token_hash").primaryKey(),
    project_id: text("project_id").notNull(),
    name: text("name").notNull(),
    note: text("note"),
    scopes: text("scopes").notNull().default("full"),
    created_at: integer("created_at").notNull(), // Unix seconds
    created_by: text("created_by").notNull(),
    last_used_at: integer("last_used_at"), // Unix seconds
    revoked_at: integer("revoked_at"), // Unix seconds
    revoked_by: text("revoked_by"),
    token_id: text("token_id").notNull().unique(),
    // DPoP sender-constraint (WI-G): RFC 7638 SHA-256 JWK thumbprint supplied by
    // the client at issue time. NULL = unbound (legacy accept); non-NULL = the
    // bearer must present a valid DPoP proof on every request.
    cnf_jkt: text("cnf_jkt"),
  },
  (table) => [index("idx_tokens_project").on(table.project_id)],
);

// --- _rate_limits ---
export const rateLimits = sqliteTable("_rate_limits", {
  ip: text("ip").primaryKey(),
  count: integer("count").notNull(),
  window_start: integer("window_start").notNull(),
});

// --- _project_repos ---
export const projectRepos = sqliteTable(
  "_project_repos",
  {
    project_id: text("project_id").notNull(),
    github_host: text("github_host").notNull().default("github.com"),
    github_owner: text("github_owner").notNull(),
    github_repo: text("github_repo").notNull(),
    github_repo_id: integer("github_repo_id").notNull(),
    min_read_permission: text("min_read_permission").notNull().default("read"),
    min_write_permission: text("min_write_permission")
      .notNull()
      .default("write"),
    oidc_permission: text("oidc_permission").notNull().default("write"),
    enabled: integer("enabled").notNull().default(1),
    created_at: integer("created_at").notNull(),
    created_by: text("created_by").notNull(),
  },
  (table) => [
    uniqueIndex("idx_project_repos_lookup").on(
      table.project_id,
      table.github_host,
      table.github_repo_id,
    ),
  ],
);

// --- _sessions ---
export const sessions = sqliteTable(
  "_sessions",
  {
    session_hash: text("session_hash").primaryKey(),
    project_id: text("project_id").notNull(),
    token_hash: text("token_hash").notNull(),
    actor_name: text("actor_name").notNull(),
    scopes: text("scopes").notNull().default("full"),
    permission: text("permission").notNull().default("read"),
    created_at: integer("created_at").notNull(), // Unix ms (EpochMillis)
    expires_at: integer("expires_at").notNull(), // Unix ms (EpochMillis)
  },
  (table) => [index("idx_sessions_expires").on(table.expires_at)],
);

// --- _idempotency ---
export const idempotency = sqliteTable(
  "_idempotency",
  {
    key: text("key").primaryKey(),
    project_id: text("project_id").notNull(),
    created_at: integer("created_at").notNull(),
    response_json: text("response_json").notNull(),
    status_code: integer("status_code").notNull(),
    request_hash: text("request_hash"),
  },
  (table) => [index("idx_idempotency_created").on(table.created_at)],
);

// --- _github_app_config ---
export const githubAppConfig = sqliteTable("_github_app_config", {
  project_id: text("project_id").primaryKey(),
  installation_id: integer("installation_id").notNull(),
  created_at: integer("created_at").notNull(),
  created_by: text("created_by").notNull(),
});

// --- _revoked_jti ---
// Stores revoked session JWT identifiers (jti claim). Rows are inserted on
// explicit revocation; the bearer-session verify path checks this table to
// implement fail-closed revocation (C9).
export const revokedJti = sqliteTable(
  "_revoked_jti",
  {
    jti: text("jti").primaryKey(),
    project_id: text("project_id").notNull(),
    revoked_at: integer("revoked_at").notNull(), // Unix ms (EpochMillis); cf. worker/src/lib/time.ts
  },
  (table) => [index("idx_revoked_jti_project").on(table.project_id)],
);

// --- _deployment_meta ---
// Singleton row (CHECK (id = 1)) holding the stable per-deployment instance id.
// Written once at provision time (CLI C7) and backfilled idempotently at runtime (C2).
export const deploymentMeta = sqliteTable("_deployment_meta", {
  id: integer("id").primaryKey(),
  instance_id: text("instance_id").notNull(),
  created_at: integer("created_at").notNull(),
});

// --- _admin_grants ---
// Per-project admin roster for GitHub-scoped governance (epic #95).
// Soft-delete model: revoke sets revoked_at rather than deleting rows,
// preserving the audit trail. Partial unique index scopes uniqueness to
// active (non-revoked) grants only, allowing re-grant after revoke.
//
// WI-C (epic #122): canonical principal identity columns added.
// identity_host / subject_id are the authoritative identity for all reads
// and writes; legacy github_host / github_user_id are retained (NOT NULL)
// for backward compatibility and audit. New rows must populate both.
export const adminGrants = sqliteTable(
  "_admin_grants",
  {
    project_id: text("project_id").notNull(),
    github_host: text("github_host").notNull().default("github.com"), // legacy; retained NOT NULL
    github_user_id: integer("github_user_id").notNull(), // legacy; retained NOT NULL
    github_login_snapshot: text("github_login_snapshot"), // display/audit only, never identity
    granted_by_user_id: integer("granted_by_user_id"), // NULL only for infra-owner-seeded rows
    granted_at: integer("granted_at").notNull(), // Unix seconds (not ms); cf. _revoked_jti which uses ms
    revoked_at: integer("revoked_at"), // Unix seconds (not ms); cf. _revoked_jti which uses ms
    revoked_by_user_id: integer("revoked_by_user_id"),
    // Canonical principal identity (WI-C). Populated via canonicalizePrincipal().
    // subject_id NOT NULL DEFAULT '' mirrors migration 0018 to avoid NULL-distinct
    // partial-index loophole (every NULL is DISTINCT in a UNIQUE index).
    identity_host: text("identity_host").notNull().default("github.com"),
    subject_id: text("subject_id").notNull().default(""),
  },
  (table) => [
    // idx_admin_grants_active_subject replaced idx_admin_grants_active (migration 0018).
    // Keyed on canonical columns (not legacy github_*) so canonicalizePrincipal()
    // parity is enforced at the index level.
    uniqueIndex("idx_admin_grants_active_subject")
      .on(table.project_id, table.identity_host, table.subject_id)
      .where(sql`${table.revoked_at} is null`),
  ],
);

// --- _revoked_subjects ---
// Bulk-revocation tombstones for subject-level principal kill-switch (WI-C, epic #122).
// One row per (project_id, identity_host, subject_id). The unique index backs the
// upsert-MAX in D1RevokedSubjectsStore.revokeSubject — revoked_before can only
// move forward, so re-arming never un-revokes already-covered sessions.
//
// IMPORTANT: rows must be written via D1RevokedSubjectsStore (which calls
// canonicalizePrincipal internally). Direct D1 inserts must be pre-canonicalized:
//   identity_host = lower(trim(host)),  subject_id = trim(cast(subject as text)).
// A non-canonical row (e.g. 'GitHub.com') will silently never match at verify time.
export const revokedSubjects = sqliteTable(
  "_revoked_subjects",
  {
    project_id: text("project_id").notNull(),
    identity_host: text("identity_host").notNull().default("github.com"),
    subject_id: text("subject_id").notNull(),
    revoked_before: integer("revoked_before").notNull(), // Unix ms (EpochMillis); never seconds
  },
  (table) => [
    uniqueIndex("idx_revoked_subjects_principal").on(
      table.project_id,
      table.identity_host,
      table.subject_id,
    ),
  ],
);
