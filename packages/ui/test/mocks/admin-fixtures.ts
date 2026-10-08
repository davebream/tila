import { http, HttpResponse } from "msw";

export const NOW = Date.now();
export const OWNER_ID = "github:github.com:1";

export const memberships = {
  owner: {
    membership_id: "m-owner",
    project_id: "test-project",
    principal_id: OWNER_ID,
    provider: "github",
    identity_host: "github.com",
    subject_id: "1",
    subject_kind: "human",
    role: "owner",
    display_name: "octocat",
    granted_by: "bootstrap:admin-seed",
    granted_at: NOW - 86_400_000,
    revoked_by: null,
    revoked_at: null,
  },
  participant: {
    membership_id: "m-hubot",
    project_id: "test-project",
    principal_id: "github:github.com:2",
    provider: "github",
    identity_host: "github.com",
    subject_id: "2",
    subject_kind: "human",
    role: "participant",
    display_name: "hubot",
    granted_by: OWNER_ID,
    granted_at: NOW - 3_600_000,
    revoked_by: null,
    revoked_at: null,
  },
  service: {
    membership_id: "m-svc",
    project_id: "test-project",
    principal_id: "service:11111111-1111-4111-8111-111111111111",
    provider: "service",
    identity_host: "tila",
    subject_id: "11111111-1111-4111-8111-111111111111",
    subject_kind: "service",
    role: "participant",
    display_name: null,
    granted_by: OWNER_ID,
    granted_at: NOW - 1_800_000,
    revoked_by: null,
    revoked_at: null,
  },
  revoked: {
    membership_id: "m-gone",
    project_id: "test-project",
    principal_id: "oidc:https://issuer.example:alice",
    provider: "oidc",
    identity_host: "issuer.example",
    subject_id: "alice",
    subject_kind: "human",
    role: "viewer",
    display_name: "alice",
    granted_by: OWNER_ID,
    granted_at: NOW - 7_200_000,
    revoked_by: OWNER_ID,
    revoked_at: NOW - 600_000,
  },
};

export const serviceAccounts = [
  {
    principal_id: "service:11111111-1111-4111-8111-111111111111",
    project_id: "test-project",
    name: "ci-bot",
    display_name: "CI bot",
    created_at: Math.floor(NOW / 1000) - 86_400,
    created_by: OWNER_ID,
    revoked_at: null,
  },
  {
    principal_id: "service:22222222-2222-4222-8222-222222222222",
    project_id: "test-project",
    name: "reporter",
    display_name: "Nightly reporter",
    created_at: Math.floor(NOW / 1000) - 86_400,
    created_by: OWNER_ID,
    revoked_at: null,
  },
];

export const tokens = [
  {
    token_id: "t-1",
    credential_id: "c-1",
    principal_id: "service:11111111-1111-4111-8111-111111111111",
    name: "ci-token",
    note: null,
    scopes: "scoped-v1",
    status: "active",
    policy: {
      role: "participant",
      capabilities: ["tasks:read", "tasks:write"],
    },
    effective_policy: {
      role: "participant",
      capabilities: ["tasks:read", "tasks:write"],
    },
    expires_at: Math.floor(NOW / 1000) + 86_400,
    legacy: false,
    created_at: Math.floor(NOW / 1000) - 3_600,
    created_by: OWNER_ID,
    last_used_at: Math.floor(NOW / 1000) - 60,
    revoked_at: null,
    revoked_by: null,
  },
  {
    token_id: "t-2",
    credential_id: "c-2",
    principal_id: "service:22222222-2222-4222-8222-222222222222",
    name: "old-token",
    note: "expired nightly",
    scopes: "scoped-v1",
    status: "expired",
    policy: { role: "viewer", capabilities: ["tasks:read"] },
    expires_at: Math.floor(NOW / 1000) - 86_400,
    legacy: false,
    created_at: Math.floor(NOW / 1000) - 172_800,
    created_by: OWNER_ID,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
  },
  {
    name: "bootstrap",
    note: null,
    scopes: "full",
    legacy: true,
    created_at: Math.floor(NOW / 1000) - 864_000,
    created_by: "infra",
    last_used_at: null,
    revoked_at: Math.floor(NOW / 1000) - 3_600,
    revoked_by: OWNER_ID,
  },
];

export const repos = [
  {
    github_host: "github.com",
    github_repo_id: 12345,
    owner: "acme",
    repo: "widgets",
    membership_enabled: true,
    membership_role_cap: "maintainer",
  },
];

export function whoamiFor(
  mode: "explicit" | "github-mirrored" | "hybrid" | "service-only",
) {
  const base = {
    ok: true,
    project_id: "test-project",
    token_name: "octocat",
    scopes: "admin",
    token_id: "",
    auth_kind: "cookie-session",
    principal_id: OWNER_ID,
    role: "owner",
    explicit_role: "owner",
    membership_sources: ["explicit"] as string[],
    legacy: true,
  };
  if (mode === "hybrid")
    return {
      ...base,
      membership_sources: ["explicit", "github-mirrored"],
      mirrored_repo_id: 12345,
    };
  return base;
}

export function sessionStatusWith(
  capabilities: Partial<{
    memberships_manage: boolean;
    credentials_manage: boolean;
    membership_available: boolean;
    auth_method: "github" | "token";
    authenticated_at: number;
    step_up_max_age_seconds: number;
  }>,
) {
  return http.get("*/auth/session/status", () =>
    HttpResponse.json({
      ok: true,
      projectId: "test-project",
      permission: "admin",
      canManageTokens: true,
      capabilities: {
        memberships_manage: true,
        credentials_manage: true,
        membership_available: true,
        auth_method: "github",
        authenticated_at: NOW - 1_000,
        step_up_max_age_seconds: 600,
        ...capabilities,
      },
    }),
  );
}

/** Default happy-path handlers for the settings page in the given mode. */
export function adminHandlers(
  mode: "explicit" | "github-mirrored" | "hybrid" | "service-only" = "explicit",
  options: { memberships?: unknown[]; tokens?: unknown[] } = {},
) {
  const rows =
    options.memberships ??
    (mode === "service-only"
      ? [memberships.service]
      : [
          memberships.owner,
          memberships.participant,
          memberships.service,
          memberships.revoked,
        ]);
  return [
    http.get("*/api/whoami", () => HttpResponse.json(whoamiFor(mode))),
    http.get("*/projects/*/membership-policy", () =>
      HttpResponse.json({ ok: true, mode }),
    ),
    http.get("*/projects/*/memberships", () =>
      HttpResponse.json({ ok: true, memberships: rows }),
    ),
    http.get("*/projects/*/membership-repos", () =>
      HttpResponse.json({ ok: true, repos: mode === "explicit" ? [] : repos }),
    ),
    http.get("*/projects/*/membership-events", () =>
      HttpResponse.json({
        ok: true,
        events: [
          {
            event_id: "e-1",
            project_id: "test-project",
            principal_id: "github:github.com:2",
            actor_principal_id: OWNER_ID,
            action: "grant",
            source: "explicit",
            role: "participant",
            github_repo_id: null,
            details: {},
            occurred_at: NOW - 3_600_000,
          },
        ],
        next_cursor: null,
      }),
    ),
    http.get("*/projects/*/service-accounts", () =>
      HttpResponse.json({ ok: true, service_accounts: serviceAccounts }),
    ),
    http.get("*/api/tokens", () =>
      HttpResponse.json({ ok: true, tokens: options.tokens ?? tokens }),
    ),
  ];
}
