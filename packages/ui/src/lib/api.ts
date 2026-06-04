import type {
  ArtifactSearchResponse,
  EntityArtifactReferenceListResponse,
  EntityDetailResponse,
  EntityListResponse,
  JournalResponse,
  PresenceAllListResponse,
  RecordGetResponse,
  RecordHistoryResponse,
  RecordListResponse,
  StateListResponse,
} from "@tila/schemas";
import { API_BASE_URL } from "./config";

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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function projectPath(projectId: string, path: string): string {
  return `/projects/${projectId}${path}`;
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
  if (!response.ok) {
    let code = `http-${response.status}`;
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* ignore parse errors */
    }
    if (response.status === 429) code = "rate-limited";
    if (response.status === 401) code = "not-configured";
    throw new ApiError(code, message);
  }
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

export async function sessionStatus(): Promise<{ projectId: string } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/session/status`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok: boolean; projectId: string };
    return { projectId: data.projectId };
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
  },
): Promise<EntityListResponse> {
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
  return request<EntityListResponse>(projectId, "/tasks", stringParams);
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
    source?: string[];
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
  if (params?.source) {
    stringParams.source = Array.isArray(params.source)
      ? params.source.join(",")
      : params.source;
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
    projectPath(projectId, `/artifacts/${key}`),
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
