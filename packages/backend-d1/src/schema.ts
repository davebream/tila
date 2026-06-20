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
    created_at: integer("created_at").notNull(),
    created_by: text("created_by").notNull(),
    last_used_at: integer("last_used_at"),
    revoked_at: integer("revoked_at"),
    revoked_by: text("revoked_by"),
    token_id: text("token_id").notNull().unique(),
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
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
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
    revoked_at: integer("revoked_at").notNull(),
  },
  (table) => [index("idx_revoked_jti_project").on(table.project_id)],
);

// --- _admin_grants ---
// Per-project admin roster for GitHub-scoped governance (epic #95).
// Soft-delete model: revoke sets revoked_at rather than deleting rows,
// preserving the audit trail. Partial unique index scopes uniqueness to
// active (non-revoked) grants only, allowing re-grant after revoke.
export const adminGrants = sqliteTable(
  "_admin_grants",
  {
    project_id: text("project_id").notNull(),
    github_host: text("github_host").notNull().default("github.com"),
    github_user_id: integer("github_user_id").notNull(),
    github_login_snapshot: text("github_login_snapshot"), // display/audit only, never identity
    granted_by_user_id: integer("granted_by_user_id"), // NULL only for infra-owner-seeded rows
    granted_at: integer("granted_at").notNull(), // Unix seconds (not ms); cf. _revoked_jti which uses ms
    revoked_at: integer("revoked_at"), // Unix seconds (not ms); cf. _revoked_jti which uses ms
    revoked_by_user_id: integer("revoked_by_user_id"),
  },
  (table) => [
    uniqueIndex("idx_admin_grants_active")
      .on(table.project_id, table.github_host, table.github_user_id)
      .where(sql`${table.revoked_at} is null`),
  ],
);
