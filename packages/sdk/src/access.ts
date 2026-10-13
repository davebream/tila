import {
  type MembershipGrantRequest,
  MembershipGrantRequestSchema,
  MembershipGrantResponseSchema,
  type ProjectMembership,
  type ProjectMembershipMode,
  ProjectMembershipModeSchema,
  type ProjectRole,
  ProjectRoleSchema,
  ProjectSettingsResponseSchema,
  type RepoAccessPolicyRequest,
  RepoAccessPolicyRequestSchema,
  RepoAccessPolicyResponseSchema,
  RepoDeleteResponseSchema,
  RepoListResponseSchema,
  type RepoOidcPolicy,
  RepoOidcPolicyResponseSchema,
  RepoOidcPolicySchema,
  UpdateProjectSettingsSchema,
} from "@tila/schemas";
import type { TilaClient } from "./client";

/** An audit event from the project membership log. */
export interface MembershipEvent {
  event_id: string;
  project_id: string;
  principal_id: string | null;
  actor_principal_id: string;
  action: string;
  source: string;
  role: ProjectRole | null;
  github_repo_id: number | null;
  details: Record<string, unknown>;
  occurred_at: number;
}

/**
 * Canonical project memberships (owner only). Removing or demoting the last
 * owner fails with `last-owner`; revocation takes effect on the next request.
 */
export function createMembershipMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const membership = (id: string) =>
    `${base}/memberships/${encodeURIComponent(id)}`;
  return {
    list: () =>
      client.get<{ ok: true; memberships: ProjectMembership[] }>(
        `${base}/memberships`,
      ),
    grant: (input: MembershipGrantRequest) =>
      client.post(
        `${base}/memberships`,
        MembershipGrantRequestSchema.parse(input),
        { schema: MembershipGrantResponseSchema.extend({}).passthrough() },
      ),
    updateRole: (membershipId: string, role: ProjectRole) =>
      client.patch<{ ok: true; membership: ProjectMembership }>(
        membership(membershipId),
        { role: ProjectRoleSchema.parse(role) },
      ),
    revoke: (membershipId: string) =>
      client.delete<{
        ok: true;
        membership: ProjectMembership;
        revokedSessions: number;
      }>(membership(membershipId)),
    policy: () =>
      client.get<{ ok: true; mode: ProjectMembershipMode }>(
        `${base}/membership-policy`,
      ),
    setPolicy: (mode: ProjectMembershipMode) =>
      client.put<{ ok: true; mode: ProjectMembershipMode }>(
        `${base}/membership-policy`,
        { mode: ProjectMembershipModeSchema.parse(mode) },
      ),
    events: (options: { cursor?: number; limit?: number } = {}) =>
      client.get<{
        ok: true;
        events: MembershipEvent[];
        next_cursor: number | null;
      }>(`${base}/membership-events`, {
        query: {
          cursor: options.cursor?.toString(),
          limit: options.limit?.toString(),
        },
      }),
  };
}

interface RepoTarget {
  /** Repository host; defaults to github.com on the server. */
  host?: string;
}
interface RepoWrite extends RepoTarget {
  /** Revision you reviewed; a stale value fails with `revision-conflict`. */
  expectedRevision?: number;
}

/**
 * Repository links and their human access and Actions OIDC policies (owner
 * only). Removing a link never removes explicit memberships.
 */
export function createRepoMethods(client: TilaClient) {
  const repo = (id: number) => `/api/repos/${encodeURIComponent(String(id))}`;
  const host = (target: RepoTarget) => ({ host: target.host });
  return {
    list: (target: RepoTarget = {}) =>
      client.get("/api/repos", {
        query: host(target),
        schema: RepoListResponseSchema,
        validate: true,
      }),
    accessPolicy: (repoId: number, target: RepoTarget = {}) =>
      client.get(`${repo(repoId)}/access-policy`, {
        query: host(target),
        schema: RepoAccessPolicyResponseSchema,
        validate: true,
      }),
    setAccessPolicy: (
      repoId: number,
      policy: RepoAccessPolicyRequest,
      write: RepoWrite = {},
    ) =>
      client.put(
        `${repo(repoId)}/access-policy`,
        {
          ...RepoAccessPolicyRequestSchema.parse(policy),
          expected_revision: write.expectedRevision,
        },
        {
          query: host(write),
          schema: RepoAccessPolicyResponseSchema,
          validate: true,
        },
      ),
    oidcPolicy: (repoId: number, target: RepoTarget = {}) =>
      client.get(`${repo(repoId)}/oidc-policy`, {
        query: host(target),
        schema: RepoOidcPolicyResponseSchema,
        validate: true,
      }),
    setOidcPolicy: (
      repoId: number,
      policy: RepoOidcPolicy,
      write: RepoWrite = {},
    ) =>
      client.put(
        `${repo(repoId)}/oidc-policy`,
        {
          ...RepoOidcPolicySchema.parse(policy),
          expected_revision: write.expectedRevision,
        },
        {
          query: host(write),
          schema: RepoOidcPolicyResponseSchema,
          validate: true,
        },
      ),
    remove: (repoId: number, write: RepoWrite = {}) =>
      client.delete(repo(repoId), {
        query: {
          ...host(write),
          expected_revision: write.expectedRevision?.toString(),
        },
        schema: RepoDeleteResponseSchema,
        validate: true,
      }),
  };
}

/** Project display metadata. Renaming is display only; IDs never change. */
export function createProjectMethods(client: TilaClient, projectId: string) {
  const path = `/projects/${encodeURIComponent(projectId)}/project-settings`;
  return {
    settings: () =>
      client.get(path, {
        schema: ProjectSettingsResponseSchema,
        validate: true,
      }),
    rename: (displayName: string | null, expectedRevision: number) =>
      client.patch(
        path,
        UpdateProjectSettingsSchema.parse({
          display_name: displayName,
          expected_revision: expectedRevision,
        }),
        { schema: ProjectSettingsResponseSchema, validate: true },
      ),
  };
}
