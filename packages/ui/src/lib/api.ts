import type {
  Agent,
  AgentArchivePreview,
  AgentArchiveResult,
  AgentListResponseSchema,
  AgentRegistration,
  ArchiveAgent,
  AttemptCorrectCommand,
  AttemptRequest,
  AttemptView,
  DeliveryExplainResponseSchema,
  DeliveryListQuery,
  DeliveryListResponse,
  MessageDeliveriesResponse,
  MessagePublishResponseSchema,
  Question,
  QuestionAnswerCommand,
  QuestionCancelCommand,
  QuestionEscalateCommand,
  QuestionListResult,
  QuestionView,
  QueueEntry,
  QueueInspection,
  QueueListQuery,
  QueuePolicy,
  QueueRequest,
  Room,
  RoomArchivePreview,
  RoomHistoryResponseSchema,
  RoomListResponseSchema,
  RoomResponseSchema,
  RuntimeViewResponseSchema,
  SetSignalGroupRequest,
  SignalGroup,
  ThreadSchema,
  UpdateAgent,
  UpdateRoom,
  WorkAttempt,
} from "@tila/schemas";
import type {
  ArtifactHistoryQuery,
  ArtifactHistoryResponse,
  ArtifactMetaResponse,
  ArtifactReviewSummary,
  ArtifactReviewsResponse,
} from "@tila/schemas";
import type {
  CredentialPolicy,
  MembershipGrantRequest,
  ProjectMembership,
  ProjectMembershipMode,
  ProjectRole,
  ProjectSettings,
  RepoAccessPolicy,
  RepoLink,
  RepoOidcPolicy,
  RuntimeEnrollment,
  RuntimeInvitation,
  ServiceAccount,
  SessionCapabilities,
  TokenIssueRequest,
  TokenListItem,
  UpdateProjectSettings,
  WhoamiResponse,
  WorkloadBinding,
  WorkloadBindingRequest,
} from "@tila/schemas";
import type {
  AcquireRequest,
  AcquireSuccessResponse,
  CreateEntityRelationshipRequest,
  CreateEntityRelationshipResponse,
  CreateEntityRequest,
  EntityResponse,
  InstantiateTemplateRequest,
  InstantiateTemplateResponse,
  RecordCreateRequest,
  RecordSetRequest,
  RecordWriteResponse,
  TemplateListResponse,
  UpdateEntityRequest,
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
  RecordTypesResponse,
  SchemaApplyResponse,
  SchemaGetResponse,
  SchemaHistory,
  SchemaHistoryEntry,
  SchemaHistoryResponse,
  SchemaPreviewResponse,
  SignalGroupsResponse,
  SignalHistoryResponse,
  StateListResponse,
  UnifiedSearchResponse,
  WorkCatalogResponse,
} from "@tila/schemas";
import {
  GitHubLoginConfigResponseSchema,
  TemplateListResponseSchema,
} from "@tila/schemas";
import {
  type JournalAppendRequest,
  JournalAppendRequestSchema,
  JournalAppendResponseSchema,
} from "@tila/schemas";
import { API_BASE_URL } from "./config";
import { encodeArtifactKey } from "./utils";

export type { ArtifactSearchResponse };

export type { RecordTypesResponse };

export type { UnifiedSearchResponse, WorkCatalogResponse };

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Structured `error.details` from the server, when present. */
    public readonly details?: unknown,
    /** HTTP status of the failed response; absent for network failures. */
    public readonly status?: number,
    /**
     * The whole `error` object. Some routes put structured extras beside
     * `code` and `message` (a schema conflict's `revision`, parse `errors`).
     */
    public readonly body?: Readonly<Record<string, unknown>>,
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
  let extras: Record<string, unknown> | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    details = body.error?.details;
    if (body.error && typeof body.error === "object") extras = body.error;
  } catch {
    /* ignore parse errors */
  }
  if (response.status === 429) code = "rate-limited";
  if (response.status === 401) code = "not-configured";
  return new ApiError(code, message, details, response.status, extras);
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
  options?: { idempotencyKey?: string },
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options?.idempotencyKey)
    headers["Idempotency-Key"] = options.idempotencyKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (/\/rooms(?:\/|$)/.test(path))
    headers["X-Tila-Conversation-Protocol"] = "1";
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
  params?: Record<string, string | string[] | undefined>,
): Promise<T> {
  const url = new URL(
    projectPath(projectId, path),
    API_BASE_URL || window.location.origin,
  );
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        // Repeated params (`?resource=a&resource=b`), not a comma list.
        for (const item of v) if (item !== "") url.searchParams.append(k, item);
      } else if (v !== undefined && v !== "") {
        url.searchParams.set(k, v);
      }
    }
  }
  const conversation = /^\/(rooms|inbox|deliveries)(\/|$)/.test(path);
  const runtime =
    /^\/(agents|runtime-view|runtime|queue|attempts|questions)(\/|$)/.test(
      path,
    );
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      credentials: "include",
      cache: conversation || runtime ? "no-store" : "default",
      headers: {
        Accept: "application/json",
        ...(conversation ? { "X-Tila-Conversation-Protocol": "1" } : {}),
        ...(/^\/(queue|attempts|questions)(\/|$)/.test(path)
          ? { "X-Tila-Participant-Id": dashboardParticipantId() }
          : {}),
      },
    });
  } catch {
    throw new ApiError("network-error", "Network error: check connection");
  }
  if (!response.ok) throw await parseErrorResponse(response);
  return response.json() as Promise<T>;
}

// --- Session management ---

export async function githubLoginConfig(signal?: AbortSignal) {
  const response = await fetch(
    absoluteUrl("/api/auth/github/login-config").toString(),
    { signal, cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw await parseErrorResponse(response);
  return GitHubLoginConfigResponseSchema.parse(await response.json());
}

export type SessionStatus = {
  projectId: string;
  /** Server-computed management flags; null when the server did not send them. */
  capabilities: SessionCapabilities | null;
};

export type SessionStatusResult =
  | SessionStatus
  | { migrationRequired: true }
  | null;

export async function sessionStatus(): Promise<SessionStatusResult> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/session/status`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      if (res.status === 401) {
        const data = (await res.json()) as { error?: { code?: string } };
        if (data.error?.code === "account-migration-required")
          return { migrationRequired: true };
      }
      return null;
    }
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
  const response = await fetch(`${API_BASE_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw await parseErrorResponse(response);
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
    sort?: TaskListSort;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
    /** Opaque keyset cursor from a previous page's `next_cursor`. */
    cursor?: string;
    blocked?: "1";
    outcome?: string[];
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
  if (params?.cursor) stringParams.cursor = params.cursor;
  if (params?.blocked) stringParams.blocked = params.blocked;
  if (params?.outcome?.length) stringParams.outcome = params.outcome.join(",");
  return request<EntityListResponse | PaginatedEntityListResponse>(
    projectId,
    "/tasks",
    stringParams,
  );
}

export type TaskListSort =
  | "created_at"
  | "updated_at"
  | "type"
  | "title"
  | "status"
  | "id";

/** Every task type the caller may read, with counts and declared definitions. */
export async function getWorkCatalog(
  projectId: string,
): Promise<WorkCatalogResponse> {
  return request<WorkCatalogResponse>(projectId, "/tasks/~/types");
}

/**
 * Server-ranked task search over the unified search endpoint. `literal` syntax
 * treats the query as plain words, so user input never trips FTS5 operators.
 */
export async function searchTasks(
  projectId: string,
  params: { q: string; type?: string[]; cursor?: string; limit?: number },
): Promise<UnifiedSearchResponse> {
  return request<UnifiedSearchResponse>(projectId, "/search", {
    q: params.q,
    kind: "task",
    syntax: "literal",
    type: params.type?.length ? params.type.join(",") : undefined,
    cursor: params.cursor,
    limit: params.limit === undefined ? undefined : String(params.limit),
  });
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
    /** One resource, or several sent as repeated `resource` params (max 10). */
    resource?: string | string[];
    kind?: string | string[];
    client_name?: string[];
    event_name?: string;
    correlation_id?: string;
    after_seq?: number;
    limit?: number;
  },
): Promise<JournalResponse> {
  const stringParams: Record<string, string | string[] | undefined> = {};
  if (params?.event_name) stringParams.event_name = params.event_name;
  if (params?.correlation_id)
    stringParams.correlation_id = params.correlation_id;
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

export async function appendJournalReport(
  projectId: string,
  input: JournalAppendRequest,
  idempotencyKey: string,
) {
  return JournalAppendResponseSchema.parse(
    await mutate(
      "POST",
      projectPath(projectId, "/journal"),
      JournalAppendRequestSchema.parse(input),
      { idempotencyKey },
    ),
  );
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

/** `GET /schema` over HTTP: the applied revision, or null when none was. */
export type AppliedSchemaResponse = Omit<SchemaGetResponse, "schema"> & {
  schema: SchemaHistory | null;
};

/** The applied project definitions; `schema` is null when none was applied. */
export async function getSchema(
  projectId: string,
): Promise<AppliedSchemaResponse> {
  return request<AppliedSchemaResponse>(projectId, "/schema");
}

/** Semantic changes and impact of `definition` against the applied revision. */
export async function previewSchema(
  projectId: string,
  definition: string,
): Promise<SchemaPreviewResponse> {
  return mutate<SchemaPreviewResponse>(
    "POST",
    projectPath(projectId, "/schema/preview"),
    { definition },
  );
}

/** `POST /schema` body the dashboard sends: always revision-checked. */
export type SchemaApplyCommand = {
  definition: string;
  expected_revision: number;
  reviewed_definition: string;
  strategy?: "relax" | "force";
};

/**
 * Apply a reviewed definition. The idempotency key makes a retry after a lost
 * response replay the server's receipt instead of recording a second revision.
 */
export async function applySchema(
  projectId: string,
  command: SchemaApplyCommand,
  idempotencyKey: string,
): Promise<SchemaApplyResponse> {
  return mutate<SchemaApplyResponse>(
    "POST",
    projectPath(projectId, "/schema"),
    command,
    { idempotencyKey },
  );
}

/** `GET /schema/history` over HTTP: stored revisions, newest first. */
export type SchemaHistoryList = Omit<SchemaHistoryResponse, "entries"> & {
  entries: SchemaHistoryEntry[];
};

/** Applied definition revisions, newest first; `before` pages by revision. */
export async function listSchemaHistory(
  projectId: string,
  params: { limit?: number; before?: number } = {},
): Promise<SchemaHistoryList> {
  return request<SchemaHistoryList>(projectId, "/schema/history", {
    limit: params.limit === undefined ? undefined : String(params.limit),
    before: params.before === undefined ? undefined : String(params.before),
  });
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
    limit?: string | number;
    /** Opaque keyset cursor from a previous page's `meta.next_cursor`. */
    cursor?: string;
    sort?: RecordListSort;
    order?: "asc" | "desc";
    /** Case-insensitive key substring, at most 200 characters. */
    key_contains?: string;
  },
): Promise<RecordListResponse> {
  const stringParams: Record<string, string | undefined> = {};
  if (params?.tag) stringParams.tag = params.tag;
  if (params?.["include-archived"])
    stringParams["include-archived"] = params["include-archived"];
  if (params?.limit !== undefined) stringParams.limit = String(params.limit);
  if (params?.cursor) stringParams.cursor = params.cursor;
  if (params?.sort) stringParams.sort = params.sort;
  if (params?.order) stringParams.order = params.order;
  if (params?.key_contains)
    stringParams.key_contains = params.key_contains.slice(0, 200);
  return request<RecordListResponse>(
    projectId,
    `/records/${type}`,
    stringParams,
  );
}

export type RecordListSort = "key" | "updated_at" | "revision";

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
  params?: { limit?: number; values?: boolean; cursor?: string },
): Promise<RecordHistoryResponse> {
  const stringParams: Record<string, string | undefined> = {};
  if (params?.limit !== undefined) stringParams.limit = String(params.limit);
  if (params?.cursor) stringParams.cursor = params.cursor;
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

export type { ServiceAccount } from "@tila/schemas";
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

// Publication uses body operation IDs and rejects Idempotency-Key. Room, agent
// and signal-group settings writes take one (see "Identity settings" below).
export type RoomHistory = (typeof RoomHistoryResponseSchema)["_output"];
export type DeliveryInspection =
  (typeof DeliveryExplainResponseSchema)["_output"];
export type AgentList = (typeof AgentListResponseSchema)["_output"];
export type AgentView = AgentList["agents"][number];
export type RoomDetail = (typeof RoomResponseSchema)["_output"];
/** Archived rooms are listed on request; room history policy still applies. */
export function listRooms(
  projectId: string,
  options: { includeArchived?: boolean } = {},
): Promise<(typeof RoomListResponseSchema)["_output"]> {
  return request(projectId, "/rooms", {
    include_archived: options.includeArchived ? "true" : undefined,
  });
}
export function getRoom(projectId: string, room: string): Promise<RoomDetail> {
  return request(projectId, `/rooms/${encodeURIComponent(room)}`);
}
export function listRoomThreads(
  projectId: string,
  room: string,
): Promise<{
  ok: true;
  threads: (typeof ThreadSchema)["_output"][];
}> {
  return request(projectId, `/rooms/${encodeURIComponent(room)}/threads`);
}
export function roomHistory(
  projectId: string,
  room: string,
  params: {
    cursor?: string;
    thread_id?: string;
    direction?: "forward" | "backward";
  } = {},
): Promise<RoomHistory> {
  return request(projectId, `/rooms/${encodeURIComponent(room)}/messages`, {
    ...params,
    limit: "50",
  });
}
export function publishReply(
  projectId: string,
  room: string,
  body: import("@tila/schemas").PublishMessage,
): Promise<(typeof MessagePublishResponseSchema)["_output"]> {
  return mutate(
    "POST",
    projectPath(projectId, `/rooms/${encodeURIComponent(room)}/messages`),
    body,
  );
}
/** `includeArchived` is honored for agent managers only. */
export function listAgents(
  projectId: string,
  options: { includeArchived?: boolean } = {},
): Promise<AgentList> {
  return request(projectId, "/agents", {
    include_archived: options.includeArchived ? "true" : undefined,
  });
}
/** Aggregate counts for readers; per-recipient traces for managers. */
export function messageDeliveries(
  projectId: string,
  room: string,
  message: string,
): Promise<MessageDeliveriesResponse> {
  return request(
    projectId,
    `/rooms/${encodeURIComponent(room)}/messages/${encodeURIComponent(message)}/deliveries`,
  );
}
/** Browse delivery traces newest first. Requires conversations:manage. */
export function listDeliveries(
  projectId: string,
  filters: DeliveryListQuery & { cursor?: string; limit?: number } = {},
): Promise<DeliveryListResponse> {
  const { expires_after, limit, ...rest } = filters;
  return request(projectId, "/deliveries", {
    ...rest,
    expires_after:
      expires_after === undefined ? undefined : String(expires_after),
    limit: String(limit ?? 50),
  });
}
export type RuntimeView = (typeof RuntimeViewResponseSchema)["_output"];
export function getRuntimeView(
  projectId: string,
  params: {
    cursor?: string;
    agent?: string;
    limit?: number;
    filter?: "attention";
  } = {},
): Promise<RuntimeView> {
  return request(projectId, "/runtime-view", {
    cursor: params.cursor,
    agent: params.agent,
    filter: params.filter,
    limit: params.limit === undefined ? undefined : String(params.limit),
  });
}
/** Release the binding only if it is still at `expectedEpoch`. */
export function releaseAgentBinding(
  projectId: string,
  agentId: string,
  expectedEpoch: number,
): Promise<{ ok: true }> {
  return mutate(
    "POST",
    projectPath(projectId, `/agents/${encodeURIComponent(agentId)}/release`),
    { expected_epoch: expectedEpoch },
  );
}
export function inspectDelivery(
  projectId: string,
  agent: string,
  delivery: string,
): Promise<DeliveryInspection> {
  return request(
    projectId,
    `/inbox/${encodeURIComponent(agent)}/deliveries/${encodeURIComponent(delivery)}`,
  );
}

export async function inspectQueue(
  projectId: string,
  query: QueueListQuery = {},
): Promise<QueueInspection> {
  const params = Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? JSON.stringify(value) : String(value),
      ]),
  );
  return (
    await request<{ result: QueueInspection }>(projectId, "/queue", params)
  ).result;
}
export async function controlQueue(
  projectId: string,
  input: Extract<
    QueueRequest,
    { action: "configure" | "enroll" | "edit" | "withdraw" }
  >,
): Promise<QueuePolicy | QueueEntry> {
  const path =
    "id" in input
      ? `entries/${encodeURIComponent(input.id)}/${input.action}`
      : input.action;
  return (
    await mutate<{ result: QueuePolicy | QueueEntry }>(
      "POST",
      projectPath(projectId, `/queue/${path}`),
      input.command,
    )
  ).result;
}
export async function getAttempt(
  projectId: string,
  id: string,
): Promise<AttemptView> {
  return (
    await request<{ result: AttemptView }>(
      projectId,
      `/attempts/${encodeURIComponent(id)}`,
    )
  ).result;
}
export async function controlAttempt(
  projectId: string,
  input: Exclude<AttemptRequest, { action: "get" | "list" }>,
): Promise<AttemptView> {
  return (
    await mutate<{ result: AttemptView }>(
      "POST",
      projectPath(
        projectId,
        `/attempts/${encodeURIComponent(input.id)}/${input.action}`,
      ),
      input.command,
    )
  ).result;
}
/**
 * Link a corrective task to a finished attempt. The original result is never
 * rewritten. Reuse the same `idempotency_key` when retrying one submission.
 */
export function correctAttempt(
  projectId: string,
  id: string,
  command: AttemptCorrectCommand,
): Promise<AttemptView> {
  return controlAttempt(projectId, { action: "correct", id, command });
}

// --- Work mutations (#305) ---
// Every write goes through `mutate()`, so it carries the dashboard participant
// id. Callers pass a stable idempotency key per logical submission so a retry
// after a lost response is answered from the server's receipt.

export async function createTask(
  projectId: string,
  body: CreateEntityRequest,
  idempotencyKey?: string,
): Promise<EntityResponse> {
  return mutate<EntityResponse>(
    "POST",
    projectPath(projectId, "/tasks"),
    body,
    {
      idempotencyKey,
    },
  );
}

/** Shallow-merge `data` into the task. Requires the current claim fence. */
export async function patchTask(
  projectId: string,
  id: string,
  body: UpdateEntityRequest,
  idempotencyKey?: string,
): Promise<EntityResponse> {
  return mutate<EntityResponse>(
    "PATCH",
    projectPath(projectId, `/tasks/${encodeURIComponent(id)}`),
    body,
    { idempotencyKey },
  );
}

export async function createTaskRelationship(
  projectId: string,
  body: CreateEntityRelationshipRequest,
): Promise<CreateEntityRelationshipResponse> {
  return mutate<CreateEntityRelationshipResponse>(
    "POST",
    projectPath(projectId, "/tasks/relationships"),
    body,
  );
}

/** Claim `resource` (`<type>:<id>`); re-acquiring as the same participant extends it. */
export async function acquireClaim(
  projectId: string,
  body: AcquireRequest,
): Promise<AcquireSuccessResponse> {
  return mutate<AcquireSuccessResponse>(
    "POST",
    projectPath(projectId, "/claims/acquire"),
    body,
  );
}

export async function releaseClaim(
  projectId: string,
  body: { resource: string; fence: number },
): Promise<unknown> {
  return mutate<unknown>(
    "POST",
    projectPath(projectId, "/claims/release"),
    body,
  );
}

export async function listTemplates(
  projectId: string,
): Promise<TemplateListResponse> {
  // Parsing fills fields an older server does not send yet.
  return TemplateListResponseSchema.parse(
    await request<unknown>(projectId, "/templates"),
  );
}

export async function instantiateTemplate(
  projectId: string,
  body: InstantiateTemplateRequest,
  idempotencyKey?: string,
): Promise<InstantiateTemplateResponse> {
  return mutate<InstantiateTemplateResponse>(
    "POST",
    projectPath(projectId, "/templates/instantiate"),
    body,
    { idempotencyKey },
  );
}

/**
 * First write of `key`; 409 when it already exists. A credential that may
 * write the key but not read it gets a receipt (`isRecordWriteReceipt`), not
 * the record.
 */
export async function createRecord(
  projectId: string,
  type: string,
  body: RecordCreateRequest,
  idempotencyKey?: string,
): Promise<RecordWriteResponse> {
  return mutate<RecordWriteResponse>(
    "POST",
    projectPath(projectId, `/records/${encodeURIComponent(type)}`),
    body,
    { idempotencyKey },
  );
}

/**
 * Full replace at the record's current fence (its write counter). The
 * response is a receipt under the rule of {@link createRecord}.
 */
export async function putRecord(
  projectId: string,
  type: string,
  key: string,
  body: RecordSetRequest,
  idempotencyKey?: string,
): Promise<RecordWriteResponse> {
  return mutate<RecordWriteResponse>(
    "PUT",
    projectPath(
      projectId,
      `/records/${encodeURIComponent(type)}/${encodeRecordKey(key)}`,
    ),
    body,
    { idempotencyKey },
  );
}

/** Attempts newest first (by fence). The server returns no total; page by offset. */
export async function listAttempts(
  projectId: string,
  query: {
    task_id?: string;
    entry_id?: string;
    active?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<WorkAttempt[]> {
  return (
    await request<{ result: WorkAttempt[] }>(projectId, "/attempts", {
      task_id: query.task_id,
      entry_id: query.entry_id,
      active: query.active === undefined ? undefined : String(query.active),
      limit: query.limit === undefined ? undefined : String(query.limit),
      offset: query.offset === undefined ? undefined : String(query.offset),
    })
  ).result;
}

export async function listQuestions(
  projectId: string,
  query: {
    task_id?: string;
    attempt_id?: string;
    responder_principal_id?: string;
    requester_principal_id?: string;
    state?: Question["state"];
    escalated?: boolean;
    after_id?: string;
    limit?: number;
  },
): Promise<QuestionListResult> {
  return (
    await request<{ result: QuestionListResult }>(projectId, "/questions", {
      ...query,
      escalated:
        query.escalated === undefined ? undefined : String(query.escalated),
      limit: query.limit === undefined ? undefined : String(query.limit),
    })
  ).result;
}

export async function getQuestion(
  projectId: string,
  id: string,
): Promise<QuestionView> {
  return (
    await request<{ result: QuestionView }>(
      projectId,
      `/questions/${encodeURIComponent(id)}`,
    )
  ).result;
}

/** The server requires the header key, when sent, to equal the command's key. */
export async function questionAction(
  projectId: string,
  id: string,
  input:
    | { action: "answer"; command: QuestionAnswerCommand }
    | { action: "escalate"; command: QuestionEscalateCommand }
    | { action: "cancel"; command: QuestionCancelCommand },
): Promise<QuestionView> {
  return (
    await mutate<{ result: QuestionView }>(
      "POST",
      projectPath(
        projectId,
        `/questions/${encodeURIComponent(id)}/${input.action}`,
      ),
      input.command,
      { idempotencyKey: input.command.idempotency_key },
    )
  ).result;
}

// --- Identity settings (#298) ---
// Agents, rooms and signal groups carry a settings revision. Every write here
// sends the revision it was reviewed against (a stale one answers 412
// `revision-conflict` with the current revision) and an Idempotency-Key: a
// retry of the same request with the same key replays the original answer.

const agentPath = (projectId: string, id: string, rest = "") =>
  projectPath(projectId, `/agents/${encodeURIComponent(id)}${rest}`);
const roomPath = (projectId: string, id: string, rest = "") =>
  projectPath(projectId, `/rooms/${encodeURIComponent(id)}${rest}`);

export function registerAgent(
  projectId: string,
  body: AgentRegistration,
  idempotencyKey: string,
): Promise<{ ok: true; agent: Agent }> {
  return mutate("POST", projectPath(projectId, "/agents"), body, {
    idempotencyKey,
  });
}

/** Configured identity and policy only; never touches the active binding. */
export function updateAgent(
  projectId: string,
  id: string,
  body: UpdateAgent,
  idempotencyKey: string,
): Promise<{ ok: true; agent: Agent }> {
  return mutate("PATCH", agentPath(projectId, id), body, { idempotencyKey });
}

export async function agentArchivePreview(
  projectId: string,
  id: string,
): Promise<AgentArchivePreview> {
  return (
    await request<{ ok: true; preview: AgentArchivePreview }>(
      projectId,
      `/agents/${encodeURIComponent(id)}/archive-preview`,
    )
  ).preview;
}

/** With an active binding, `expected_epoch` must name the reviewed occupant. */
export function archiveAgent(
  projectId: string,
  id: string,
  body: ArchiveAgent,
  idempotencyKey: string,
): Promise<{ ok: true } & AgentArchiveResult> {
  return mutate("POST", agentPath(projectId, id, "/archive"), body, {
    idempotencyKey,
  });
}

export function unarchiveAgent(
  projectId: string,
  id: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<{ ok: true; agent: Agent }> {
  return mutate(
    "POST",
    agentPath(projectId, id, "/unarchive"),
    { expected_revision: expectedRevision },
    { idempotencyKey },
  );
}

export type RoomCreate = {
  id: string;
  name: string;
  history_policy: Room["history_policy"];
  delivery_ttl_seconds: number;
  budgets: Room["budgets"];
};

export function createRoom(
  projectId: string,
  body: RoomCreate,
  idempotencyKey: string,
): Promise<{ ok: true; room: Room }> {
  return mutate("POST", projectPath(projectId, "/rooms"), body, {
    idempotencyKey,
  });
}

export function updateRoom(
  projectId: string,
  id: string,
  body: UpdateRoom,
  idempotencyKey: string,
): Promise<{ ok: true; room: Room }> {
  return mutate("PATCH", roomPath(projectId, id), body, { idempotencyKey });
}

/** Add a member or change its wake; answers the room at its new revision. */
export function setRoomMember(
  projectId: string,
  id: string,
  member: string,
  body: { wake: boolean; expected_revision: number },
  idempotencyKey: string,
): Promise<{ ok: true; room: Room }> {
  return mutate(
    "PUT",
    roomPath(projectId, id, `/members/${encodeURIComponent(member)}`),
    body,
    { idempotencyKey },
  );
}

export function removeRoomMember(
  projectId: string,
  id: string,
  member: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<{ ok: true; room: Room }> {
  return mutate(
    "DELETE",
    roomPath(
      projectId,
      id,
      `/members/${encodeURIComponent(member)}?expected_revision=${expectedRevision}`,
    ),
    undefined,
    { idempotencyKey },
  );
}

export async function roomArchivePreview(
  projectId: string,
  id: string,
): Promise<RoomArchivePreview> {
  return (
    await request<{ ok: true; preview: RoomArchivePreview }>(
      projectId,
      `/rooms/${encodeURIComponent(id)}/archive-preview`,
    )
  ).preview;
}

export function setRoomArchived(
  projectId: string,
  id: string,
  archived: boolean,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<{ ok: true; room: Room }> {
  return mutate(
    "POST",
    roomPath(projectId, id, archived ? "/archive" : "/unarchive"),
    { expected_revision: expectedRevision },
    { idempotencyKey },
  );
}

/** `expected_revision` 0 creates only; a positive one must be current. */
export function putSignalGroup(
  projectId: string,
  id: string,
  body: SetSignalGroupRequest & { expected_revision: number },
  idempotencyKey: string,
): Promise<{ ok: true; group: SignalGroup }> {
  return mutate(
    "PUT",
    projectPath(projectId, `/signals/groups/${encodeURIComponent(id)}`),
    body,
    { idempotencyKey },
  );
}

/** Stops later sends to the group; past deliveries keep their recipients. */
export function deleteSignalGroup(
  projectId: string,
  id: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<{ ok: true }> {
  return mutate(
    "DELETE",
    projectPath(
      projectId,
      `/signals/groups/${encodeURIComponent(id)}?expected_revision=${expectedRevision}`,
    ),
    undefined,
    { idempotencyKey },
  );
}

// --- Access settings (#298) ---
// Owner-level editors. Writes from a cookie session older than the step-up
// window answer 403 `step-up-required`; revisioned ones answer 412
// `revision-conflict` with the current revision.

/** The project's display metadata; IDs and creation provenance are fixed. */
export async function getProjectSettings(
  projectId: string,
): Promise<ProjectSettings> {
  return (
    await request<{ ok: true; settings: ProjectSettings }>(
      projectId,
      "/project-settings",
    )
  ).settings;
}

export async function updateProjectSettings(
  projectId: string,
  body: UpdateProjectSettings,
): Promise<ProjectSettings> {
  return (
    await mutate<{ ok: true; settings: ProjectSettings }>(
      "PATCH",
      projectPath(projectId, "/project-settings"),
      body,
    )
  ).settings;
}

/** A linked repository is addressed by its host and numeric GitHub ID. */
export type RepoTarget = { host: string; repoId: number };

const repoPath = ({ host, repoId }: RepoTarget, rest = "", query = "") =>
  `/api/repos/${repoId}${rest}?host=${encodeURIComponent(host)}${query}`;

/** Repositories linked to the session's project, with both policies. */
export async function listRepoLinks(): Promise<RepoLink[]> {
  return (await requestAbsolute<{ ok: true; repos: RepoLink[] }>("/api/repos"))
    .repos;
}

/** The server resolves the repository ID through GitHub. */
export function registerRepo(body: {
  owner: string;
  repo: string;
  github_host: string;
}): Promise<{ ok: true; github_repo_id: number; full_name: string }> {
  return mutate("POST", "/api/repos", body);
}

export function setRepoAccessPolicy(
  target: RepoTarget,
  body: RepoAccessPolicy & { expected_revision: number },
): Promise<{ ok: true; policy: RepoAccessPolicy; revision?: number }> {
  return mutate("PUT", repoPath(target, "/access-policy"), body);
}

export function setRepoOidcPolicy(
  target: RepoTarget,
  body: RepoOidcPolicy & { expected_revision: number },
): Promise<{ ok: true; policy: RepoOidcPolicy; revision?: number }> {
  return mutate("PUT", repoPath(target, "/oidc-policy"), body);
}

/** Removes the link only; explicit memberships stay. */
export function removeRepoLink(
  target: RepoTarget,
  expectedRevision: number,
): Promise<{ ok: true }> {
  return mutate(
    "DELETE",
    repoPath(target, "", `&expected_revision=${expectedRevision}`),
  );
}

export type { WorkloadBinding } from "@tila/schemas";

const servicePath = (projectId: string, principalId: string, rest = "") =>
  projectPath(
    projectId,
    `/service-accounts/${encodeURIComponent(principalId)}${rest}`,
  );

export function createServiceAccount(
  projectId: string,
  body: { name: string; display_name: string; role: ProjectRole },
): Promise<{ ok: true; service_account: ServiceAccount }> {
  return mutate("POST", projectPath(projectId, "/service-accounts"), body);
}

export function renameServiceAccount(
  projectId: string,
  principalId: string,
  displayName: string,
  expectedRevision?: number,
): Promise<{ ok: true; service_account: ServiceAccount }> {
  return mutate("PATCH", servicePath(projectId, principalId), {
    display_name: displayName,
    expected_revision: expectedRevision,
  });
}

/** Stops its credentials and workload exchanges; attribution is kept. */
export function revokeServiceAccount(
  projectId: string,
  principalId: string,
): Promise<{ ok: true }> {
  return mutate("DELETE", servicePath(projectId, principalId));
}

export async function listWorkloadBindings(
  projectId: string,
  principalId: string,
): Promise<WorkloadBinding[]> {
  return (
    await request<{ ok: true; bindings: WorkloadBinding[] }>(
      projectId,
      `/service-accounts/${encodeURIComponent(principalId)}/workload-bindings`,
    )
  ).bindings;
}

export function createWorkloadBinding(
  projectId: string,
  principalId: string,
  body: WorkloadBindingRequest,
): Promise<{ ok: true; binding: WorkloadBinding }> {
  return mutate(
    "POST",
    servicePath(projectId, principalId, "/workload-bindings"),
    body,
  );
}

export function updateWorkloadBinding(
  projectId: string,
  principalId: string,
  bindingId: string,
  policy: CredentialPolicy,
  expectedRevision?: number,
): Promise<{ ok: true; binding: WorkloadBinding }> {
  return mutate(
    "PATCH",
    servicePath(
      projectId,
      principalId,
      `/workload-bindings/${encodeURIComponent(bindingId)}`,
    ),
    { policy, expected_revision: expectedRevision },
  );
}

export function revokeWorkloadBinding(
  projectId: string,
  principalId: string,
  bindingId: string,
): Promise<{ ok: true }> {
  return mutate(
    "DELETE",
    servicePath(
      projectId,
      principalId,
      `/workload-bindings/${encodeURIComponent(bindingId)}`,
    ),
  );
}

/**
 * A newly issued or rotated credential. `token` is the secret: it is returned
 * once and must never be stored (no draft, session storage or query cache).
 */
export type IssuedCredential = {
  token: string;
  credential_id: string;
  token_id: string;
  principal_id: string;
  name: string;
  created_at: number;
  expires_at: number | null;
  policy?: CredentialPolicy;
};

/** Not idempotent: a lost answer cannot be replayed, only checked in the list. */
export function issueCredential(
  body: TokenIssueRequest,
): Promise<{ ok: true } & IssuedCredential> {
  return mutate("POST", "/api/tokens", body);
}

/** Compare-and-swap on the listed version; the old secret retires after the overlap. */
export function rotateCredential(
  name: string,
  body: { expected_token_id: string; overlap_seconds: number },
): Promise<{ ok: true } & IssuedCredential> {
  return mutate("POST", `/api/tokens/${encodeURIComponent(name)}/rotate`, body);
}

/** Owners see every installation; other members those they sponsor. */
export async function listRuntimeEnrollments(
  projectId: string,
): Promise<RuntimeEnrollment[]> {
  return (
    await request<{ ok: true; enrollments: RuntimeEnrollment[] }>(
      projectId,
      "/runtime/enrollments",
    )
  ).enrollments;
}

/** Ends the installation's credentials and its agent bindings. */
export function revokeRuntimeEnrollment(
  projectId: string,
  enrollmentId: string,
): Promise<{ ok: true }> {
  return mutate(
    "POST",
    projectPath(
      projectId,
      `/runtime/enrollments/${encodeURIComponent(enrollmentId)}/revoke`,
    ),
  );
}

export async function listRuntimeInvitations(
  projectId: string,
): Promise<RuntimeInvitation[]> {
  return (
    await request<{ ok: true; invitations: RuntimeInvitation[] }>(
      projectId,
      "/runtime/invitations",
    )
  ).invitations;
}

/** `invitation` is the bearer secret, shown once. */
export function createRuntimeInvitation(
  projectId: string,
  body: { name: string; policy?: CredentialPolicy },
): Promise<{
  ok: true;
  invitation: string;
  expires_at: number;
  invitation_id?: string;
}> {
  return mutate("POST", projectPath(projectId, "/runtime/invitations"), body);
}

/** Stops later redemption; installations already enrolled stay. */
export function revokeRuntimeInvitation(
  projectId: string,
  invitationId: string,
): Promise<{ ok: true; revoked: boolean }> {
  return mutate(
    "POST",
    projectPath(
      projectId,
      `/runtime/invitations/${encodeURIComponent(invitationId)}/revoke`,
    ),
  );
}
