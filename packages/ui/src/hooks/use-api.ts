import { useAuth } from "@/hooks/use-auth";
import {
  ApiError,
  type ArtifactListResponse,
  type RecordTypesResponse,
  getRecord,
  getRecordHistory,
  getTaskDetail,
  listArtifacts,
  listClaims,
  listJournal,
  listPresenceAll,
  listRecordTypes,
  listRecords,
  listTaskArtifactRefs,
  listTasks,
  searchArtifacts,
} from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type {
  ArtifactSearchResponse,
  RecordGetResponse,
  RecordHistoryResponse,
  RecordListResponse,
} from "@tila/schemas";

function requireProjectId(projectId: string | null): string {
  if (!projectId) throw new ApiError("not-configured", "No active session.");
  return projectId;
}

export function useTasks(params?: {
  type?: string | string[];
  status?: string | string[];
  parent?: string;
  archived?: string;
  compact?: boolean;
  sort?: "created_at" | "updated_at" | "type" | "title" | "status";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["tasks", projectId, params],
    queryFn: () => listTasks(requireProjectId(projectId), params),
    enabled: Boolean(projectId),
    refetchInterval: 5000,
  });
}

export function useTaskIndex() {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["task-index", projectId],
    queryFn: () =>
      listTasks(requireProjectId(projectId), {
        compact: true,
        limit: 200,
        sort: "updated_at",
        order: "desc",
      }),
    enabled: Boolean(projectId),
    refetchInterval: 15000,
    staleTime: 5000,
  });
}

export function useTask(id: string) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["task", projectId, id],
    queryFn: () => getTaskDetail(requireProjectId(projectId), id),
    enabled: Boolean(projectId),
    refetchInterval: 5000,
  });
}

export function useClaims() {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["claims", projectId],
    queryFn: () => listClaims(requireProjectId(projectId)),
    enabled: Boolean(projectId),
    refetchInterval: 5000,
  });
}

export function useTaskArtifactRefs(taskId: string) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["taskArtifactRefs", projectId, taskId],
    queryFn: () => listTaskArtifactRefs(requireProjectId(projectId), taskId),
    enabled: Boolean(projectId),
    refetchInterval: 5000,
  });
}

export function useJournal(params?: {
  resource?: string;
  kind?: string;
  after_seq?: number;
  limit?: number;
}) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["journal", projectId, params],
    queryFn: () => listJournal(requireProjectId(projectId), params),
    enabled: Boolean(projectId),
    refetchInterval: 3000,
  });
}

export function usePresence() {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["presence", projectId],
    queryFn: () => listPresenceAll(requireProjectId(projectId)),
    enabled: Boolean(projectId),
    refetchInterval: 10000,
  });
}

export function useArtifacts(params?: {
  resource?: string;
  kind?: string | string[];
  limit?: number;
}) {
  const { projectId } = useAuth();
  return useQuery<ArtifactListResponse>({
    queryKey: ["artifacts", projectId, params],
    queryFn: () => listArtifacts(requireProjectId(projectId), params),
    enabled: Boolean(projectId),
    refetchInterval: 10000,
  });
}

export function useArtifactSearch(params: {
  q: string;
  kind?: string | string[];
  limit?: number;
}) {
  const { projectId } = useAuth();
  return useQuery<ArtifactSearchResponse>({
    queryKey: ["artifactSearch", projectId, params],
    queryFn: () => searchArtifacts(requireProjectId(projectId), params),
    enabled: Boolean(projectId) && Boolean(params.q),
  });
}

export function useRecordTypes() {
  const { projectId } = useAuth();
  return useQuery<RecordTypesResponse>({
    queryKey: ["recordTypes", projectId],
    queryFn: () => listRecordTypes(requireProjectId(projectId)),
    enabled: Boolean(projectId),
    refetchInterval: 30000,
  });
}

export function useRecords(
  type: string | undefined,
  params?: { tag?: string; "include-archived"?: string },
) {
  const { projectId } = useAuth();
  return useQuery<RecordListResponse>({
    queryKey: ["records", projectId, type, params],
    queryFn: () =>
      listRecords(requireProjectId(projectId), type as string, params),
    enabled: Boolean(projectId) && Boolean(type),
    refetchInterval: 5000,
  });
}

export function useRecord(type: string | undefined, key: string | undefined) {
  const { projectId } = useAuth();
  return useQuery<RecordGetResponse>({
    queryKey: ["record", projectId, type, key],
    queryFn: () =>
      getRecord(requireProjectId(projectId), type as string, key as string),
    enabled: Boolean(projectId) && Boolean(type) && Boolean(key),
    refetchInterval: 5000,
  });
}

export function useRecordHistory(
  type: string | undefined,
  key: string | undefined,
  params?: { limit?: number },
) {
  const { projectId } = useAuth();
  return useQuery<RecordHistoryResponse>({
    queryKey: ["recordHistory", projectId, type, key, params],
    queryFn: () =>
      getRecordHistory(
        requireProjectId(projectId),
        type as string,
        key as string,
        params,
      ),
    enabled: Boolean(projectId) && Boolean(type) && Boolean(key),
    refetchInterval: 10000,
  });
}
