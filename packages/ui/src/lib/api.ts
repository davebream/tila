import type {
  ArtifactHistoryQuery,
  ArtifactHistoryResponse,
  ArtifactMetaResponse,
  ArtifactReviewSummary,
  ArtifactReviewsResponse,
} from "@tila/schemas";
import type {
  MembershipGrantRequest,
  ProjectMembership,
  ProjectMembershipMode,
  ProjectRole,
  SessionCapabilities,
  TokenListItem,
  WhoamiResponse,
} from "@tila/schemas";
import type {
  ArtifactSearchResponse,
  EntityArtifactReferenceListResponse,
  EntityDetailResponse,
  EntityListResponse,
  JournalResponse,
  PaginatedEntityListResponse,
  PresenceAllListResponse,
  RecordGetResponse,
  RecordHistoryResponse,
  RecordListResponse,
  SignalGroupsResponse,
  SignalHistoryResponse,
  StateListResponse,
} from "@tila/schemas";
import { API_BASE_URL } from "./config";
import { encodeArtifactKey } from "./utils";

export type { ArtifactSearchResponse };

export type RecordTypesResponse = {
  ok: true;
  types: string[];
  declared_types: string[];
  in_use_types: string[];
};

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Structured `error.details` from the server, when present. */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function projectPath(projectId: string, path: string): string {
  return `/projects/${projectId}${path}`;
}

function absoluteUrl(path: string): URL {
  return new URL(path, API_BASE_URL || window.location.origin);
}

/** Map a non-2xx response to an ApiError carrying the server's error envelope. */
async function parseErrorResponse(response: Response): Promise<ApiError> {
  let code = `http-${response.status}`;
  let message = `HTTP ${response.status}`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    details = body.error?.details;
  } catch {
    /* ignore parse errors */
  }
  if (response.status === 429) code = "rate-limited";
  if (response.status === 401) code = "not-configured";
  return new ApiError(code, message, details);
}

const PARTICIPANT_KEY = "tila.participantId";

/**
 * Stable participant id for this browser profile. Project mutations require
 * `X-Tila-Participant-Id` (journal attribution); the dashboard mints one per
 * browser and keeps it in localStorage so audit rows stay correlated.
 */
export function dashboardParticipantId(): string {
  try {
    const existing = window.localStorage.getItem(PARTICIPANT_KEY);
    if (existing) return existing;
    const fresh = `dashboard-${crypto.randomUUID()}`;
    window.localStorage.setItem(PARTICIPANT_KEY, fresh);
    return fresh;
  } catch {
    return "dashboard";
  }
}

/**
 * Send a write request with the session cookie. Project mutations carry the
 * participant id the Worker requires; the Worker's CSRF guard relies on the
 * browser-supplied `Origin` header, so no CSRF token is needed.
 */
export async function mutate<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (path.startsWith("/projects/")) {
    headers["X-Tila-Participant-Id"] = dashboardParticipantId();
    headers["X-Tila-Client-Name"] = "dashboard";
  }
  let response: Response;
  try {
    response = await fetch(absoluteUrl(path).toString(), {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network-error", "Network error: check connection");
  }
  if (!response.ok) throw await parseErrorResponse(response);
  return response.json() as Promise<T>;
}

/** GET an absolute (non-project) API path with the session cookie. */
async function requestAbsolute<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(absoluteUrl(path).toString(), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new ApiError("network-error", "Network error: check connection");
  }
  if (!response.ok) throw await parseErrorResponse(response);
  return response.json() as Promise<T>;
}

async function request<T>(
  projectId: string,
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(
    projectPath(projectId, path),
    API_BASE_URL || window.location.origin,
  );
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new ApiError("network-error", "Network error: check connection");
  }
  if (!response.ok) throw await parseErrorResponse(response);
  return response.json() as Promise<T>;
}

// --- Session management ---

export async function sessionExchange(
  token: string,
  projectId: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/auth/session`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, project_id: projectId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({
      error: { message: "Exchange failed" },
    }))) as { error?: { message?: string } };
    throw new ApiError(
      `http-${res.status}`,
      body.error?.message ?? "Session exchange failed",
    );
  }
}

export type SessionStatus = {
  projectId: string;
  /** Server-computed management flags; null when the server did not send them. */
  capabilities: SessionCapabilities | null;
};

export async function sessionStatus(): Promise<SessionStatus | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/session/status`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ok: boolean;
      projectId: string;
      capabilities?: SessionCapabilities;
    };
    return {
      projectId: data.projectId,
      capabilities: data.capabilities ?? null,
    };
  } catch {
    return null;
  }
}

export async function sessionLogout(): Promise<void> {
  await fetch(`${API_BASE_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

// --- Data fetching ---

export async function listTasks(
  projectId: string,
  params?: {
    type?: string | string[];
    status?: string | string[];
    parent?: string;
    archived?: string;
    compact?: boolean;
    sort?: "created_at" | "updated_at" | "type" | "title" | "status";
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  },
): Promise<EntityListResponse | PaginatedEntityListResponse> {
  const stringParams: Record<string, string | undefined> = {};
  if (params?.type) {
    stringParams.type = Array.isArray(params.type)
      ? params.type.join(",")
      : params.type;
  }
  if (params?.status) {
    stringParams.status = Array.isArray(params.status)
      ? params.status.join(",")
      : params.status;
  }
  if (params?.parent) stringParams.parent = params.parent;
  if (params?.archived) stringParams.archived = params.archived;
  if (params?.compact) stringParams.compact = "true";
  if (params?.sort) stringParams.sort = params.sort;
  if (params?.order) stringParams.order = params.order;
  if (params?.limit !== undefined) stringParams.limit = String(params.limit);
  if (params?.offset !== undefined) stringParams.offset = String(params.offset);
  return request<EntityListResponse | PaginatedEntityListResponse>(
    projectId,
    "/tasks",
    stringParams,
  );
}

export async function getTaskDetail(
  projectId: string,
  id: string,
): Promise<EntityDetailResponse> {
  return request<EntityDetailResponse>(projectId, `/tasks/${id}`);
}

export async function listClaims(
  projectId: string,
): Promise<StateListResponse> {
  return request<StateListResponse>(projectId, "/claims");
}

export async function listJournal(
  projectId: string,
  params?: {
    resource?: string;
    kind?: string | string[];
    client_name?: string[];
    after_seq?: number;
    limit?: number;
  },
): Promise<JournalResponse> {
  const stringParams: Record<string, string | undefined> = {};
  if (params?.resource) stringParams.resource = params.resource;
  if (params?.kind) {
    stringParams.kind = Array.isArray(params.kind)
      ? params.kind.join(",")
      : params.kind;
  }
  if (params?.client_name) {
    stringParams.client_name = Array.isArray(params.client_name)
      ? params.client_name.join(",")
      : params.client_name;
  }
  if (params?.after_seq !== undefined)
    stringParams.after_seq = String(params.after_seq);
  if (params?.limit !== undefined) stringParams.limit = String(params.limit);
  return request<JournalResponse>(projectId, "/journal", stringParams);
}

export async function listPresenceAll(
  projectId: string,
): Promise<PresenceAllListResponse> {
  return request<PresenceAllListResponse>(projectId, "/presence/all");
}

export async function listSignalHistory(
  projectId: string,
  params?: { cursor?: string; limit?: number },
): Promise<SignalHistoryResponse> {
  return request<SignalHistoryResponse>(projectId, "/signals/history", {
    cursor: params?.cursor,
    limit: params?.limit === undefined ? undefined : String(params.limit),
  });
}

export async function listSignalGroups(
  projectId: string,
): Promise<SignalGroupsResponse> {
  return request<SignalGroupsResponse>(projectId, "/signals/groups");
}

export async function listTaskArtifactRefs(
  projectId: string,
  taskId: string,
): Promise<EntityArtifactReferenceListResponse> {
  return request<EntityArtifactReferenceListResponse>(
    projectId,
    `/tasks/${taskId}/artifact-refs`,
  );
}

// Artifact list response type — not yet in @tila/schemas
export type ArtifactListResponse = {
  ok: true;
  artifacts: Array<{
    review?: ArtifactReviewSummary;
    r2_key: string;
    resource: string | null;
    kind: string;
    sha256: string;
    bytes: number;
    mime_type: string;
    produced_at: number;
    produced_by: string;
    expires_at: number | null;
    tombstoned: number;
  }>;
};

export async function listArtifacts(
  projectId: string,
  params?: {
    resource?: string;
    kind?: string | string[];
    limit?: number;
  },
): Promise<ArtifactListResponse> {
  const stringParams: Record<string, string | undefined> = {};
  if (params?.resource) stringParams.resource = params.resource;
  if (params?.kind) {
    stringParams.kind = Array.isArray(params.kind)
      ? params.kind.join(",")
      : params.kind;
  }
  if (params?.limit !== undefined) stringParams.limit = String(params.limit);
  const raw = await request<{
    ok: true;
    pointers?: ArtifactListResponse["artifacts"];
    artifacts?: ArtifactListResponse["artifacts"];
  }>(projectId, "/artifacts", stringParams);
  return { ok: true, artifacts: raw.pointers ?? raw.artifacts ?? [] };
}

export async function searchArtifacts(
  projectId: string,
  params: {
    q: string;
    kind?: string | string[];
    limit?: number;
  },
): Promise<ArtifactSearchResponse> {
  const stringParams: Record<string, string | undefined> = { q: params.q };
  if (params.kind) {
    stringParams.kind = Array.isArray(params.kind)
      ? params.kind.join(",")
      : params.kind;
  }
  if (params.limit !== undefined) stringParams.limit = String(params.limit);
  return request<ArtifactSearchResponse>(
    projectId,
    "/artifacts/search",
    stringParams,
  );
}

export async function workspaceProjects(): Promise<{
  projects: Array<{
    projectId: string;
    displayName: string;
    repos: Array<{ owner: string; repo: string; permission: string }>;
  }>;
}> {
  const res = await fetch(`${API_BASE_URL}/api/workspace/projects`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let code = `http-${res.status}`;
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(code, message);
  }
  return res.json();
}

export async function workspaceDeselect(): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/workspace/deselect`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    let code = `http-${res.status}`;
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(code, message);
  }
}

export async function workspaceSelect(
  projectId: string,
): Promise<{ ok: boolean; projectId: string; scopes: string }> {
  const res = await fetch(`${API_BASE_URL}/api/workspace/select`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) {
    let code = `http-${res.status}`;
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(code, message);
  }
  return res.json();
}

// --- Records ---

function encodeRecordKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function listRecordTypes(
  projectId: string,
): Promise<RecordTypesResponse> {
  return request<RecordTypesResponse>(projectId, "/records/_types");
}

export async function listRecords(
  projectId: string,
  type: string,
  params?: {
    tag?: string;
    "include-archived"?: string;
    limit?: string;
  },
): Promise<RecordListResponse> {
  const stringParams: Record<string, string | undefined> = {};
  if (params?.tag) stringParams.tag = params.tag;
  if (params?.["include-archived"])
    stringParams["include-archived"] = params["include-archived"];
  if (params?.limit) stringParams.limit = params.limit;
  return request<RecordListResponse>(
    projectId,
    `/records/${type}`,
    stringParams,
  );
}

export async function getRecord(
  projectId: string,
  type: string,
  key: string,
): Promise<RecordGetResponse> {
  return request<RecordGetResponse>(
    projectId,
    `/records/${type}/${encodeRecordKey(key)}`,
  );
}

export async function getRecordHistory(
  projectId: string,
  type: string,
  key: string,
  params?: { limit?: number; values?: boolean },
): Promise<RecordHistoryResponse> {
  const stringParams: Record<string, string | undefined> = {};
  if (params?.limit !== undefined) stringParams.limit = String(params.limit);
  if (params?.values !== undefined) stringParams.values = String(params.values);
  return request<RecordHistoryResponse>(
    projectId,
    `/records/${type}/~/history/${encodeRecordKey(key)}`,
    stringParams,
  );
}

export async function getArtifactBlob(
  projectId: string,
  key: string,
): Promise<Response> {
  const url = new URL(
    projectPath(projectId, `/artifacts/${encodeArtifactKey(key)}`),
    API_BASE_URL || window.location.origin,
  );
  let response: Response;
  try {
    response = await fetch(url.toString(), { credentials: "include" });
  } catch {
    throw new ApiError("network-error", "Network error: check connection");
  }
  if (!response.ok) {
    throw new ApiError(`http-${response.status}`, `HTTP ${response.status}`);
  }
  return response;
}

export function getArtifactMeta(
  projectId: string,
  key: string,
): Promise<ArtifactMetaResponse> {
  return request(projectId, `/artifacts/${encodeURIComponent(key)}/meta`);
}

export function getArtifactHistory(
  projectId: string,
  key: string,
  params?: ArtifactHistoryQuery,
): Promise<ArtifactHistoryResponse> {
  return request(projectId, `/artifacts/~/history/${encodeURIComponent(key)}`, {
    limit: params?.limit === undefined ? undefined : String(params.limit),
    cursor: params?.cursor,
  });
}
export function getArtifactReviews(
  projectId: string,
  key: string,
  beforeRevision?: number,
): Promise<ArtifactReviewsResponse> {
  return request(
    projectId,
    `/artifacts/~/reviews/${encodeURIComponent(key)}`,
    beforeRevision === undefined
      ? undefined
      : { before_revision: String(beforeRevision) },
  );
}

// --- Project administration (#102) ---
//
// Every function here is gated in the UI by `SessionCapabilities` from
// `/auth/session/status`; the server enforces the same owner checks and may
// additionally answer 403 `step-up-required` for mutations from a stale session.

export type MembershipEvent = {
  event_id: string;
  project_id: string;
  principal_id: string;
  actor_principal_id: string;
  action: "grant" | "role-change" | "revoke" | "policy-change" | string;
  source: string;
  role: ProjectRole | null;
  github_repo_id: number | null;
  details: Record<string, unknown>;
  occurred_at: number;
};

export type MembershipRepo = {
  github_host: string;
  github_repo_id: number;
  owner: string;
  repo: string;
  membership_enabled: boolean;
  membership_role_cap: Exclude<ProjectRole, "owner">;
};

export type ServiceAccount = {
  principal_id: string;
  project_id: string;
  name: string;
  display_name: string;
  created_at: number;
  created_by: string;
  revoked_at: number | null;
};

export function getMembershipPolicy(
  projectId: string,
): Promise<{ ok: true; mode: ProjectMembershipMode }> {
  return request(projectId, "/membership-policy");
}

export function setMembershipPolicy(
  projectId: string,
  mode: ProjectMembershipMode,
): Promise<{ ok: true; mode: ProjectMembershipMode }> {
  return mutate("PUT", projectPath(projectId, "/membership-policy"), { mode });
}

export function listMemberships(
  projectId: string,
  params?: { includeRevoked?: boolean },
): Promise<{ ok: true; memberships: ProjectMembership[] }> {
  return request(projectId, "/memberships", {
    include_revoked: params?.includeRevoked ? "true" : undefined,
  });
}

export function grantMembership(
  projectId: string,
  body: MembershipGrantRequest,
): Promise<{ ok: true; membership: ProjectMembership; created: boolean }> {
  return mutate("POST", projectPath(projectId, "/memberships"), body);
}

export function updateMembershipRole(
  projectId: string,
  membershipId: string,
  role: ProjectRole,
): Promise<{ ok: true; membership: ProjectMembership }> {
  return mutate(
    "PATCH",
    projectPath(projectId, `/memberships/${encodeURIComponent(membershipId)}`),
    { role },
  );
}

export function revokeMembership(
  projectId: string,
  membershipId: string,
): Promise<{
  ok: true;
  membership: ProjectMembership;
  revokedSessions: number;
}> {
  return mutate(
    "DELETE",
    projectPath(projectId, `/memberships/${encodeURIComponent(membershipId)}`),
  );
}

export function listMembershipEvents(
  projectId: string,
  params?: { cursor?: number | null; limit?: number },
): Promise<{
  ok: true;
  events: MembershipEvent[];
  next_cursor: number | null;
}> {
  return request(projectId, "/membership-events", {
    cursor:
      params?.cursor === undefined || params.cursor === null
        ? undefined
        : String(params.cursor),
    limit: params?.limit === undefined ? undefined : String(params.limit),
  });
}

export function listMembershipRepos(
  projectId: string,
): Promise<{ ok: true; repos: MembershipRepo[] }> {
  return request(projectId, "/membership-repos");
}

export function listServiceAccounts(
  projectId: string,
): Promise<{ ok: true; service_accounts: ServiceAccount[] }> {
  return request(projectId, "/service-accounts");
}

/** Credentials of the active session's project. Never returns secret material. */
export function listTokens(): Promise<{ ok: true; tokens: TokenListItem[] }> {
  return requestAbsolute("/api/tokens");
}

export function revokeToken(
  name: string,
): Promise<{ ok: true; name: string; revoked_at: number }> {
  return mutate("DELETE", `/api/tokens/${encodeURIComponent(name)}`);
}

export function whoami(): Promise<WhoamiResponse> {
  return requestAbsolute("/api/whoami");
}

/**
 * Resolve a GitHub login to its numeric user id from the browser, using
 * GitHub's public CORS-enabled endpoint. This keeps explicit-membership
 * projects administrable without a GitHub App. Unauthenticated calls are
 * limited to 60 per hour per client IP; callers offer a manual id fallback.
 */
export async function githubUserLookup(
  login: string,
): Promise<{ id: number; login: string }> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
  } catch {
    throw new ApiError("github-lookup-failed", "Could not reach GitHub");
  }
  if (response.status === 404)
    throw new ApiError("github-user-not-found", `No GitHub user "${login}"`);
  if (response.status === 403 || response.status === 429)
    throw new ApiError(
      "github-rate-limited",
      "GitHub lookup rate limit reached; enter the numeric user id instead",
    );
  if (!response.ok)
    throw new ApiError(
      "github-lookup-failed",
      `GitHub lookup failed (${response.status})`,
    );
  const data = (await response.json()) as { id: number; login: string };
  return { id: data.id, login: data.login };
}
