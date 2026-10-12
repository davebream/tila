import { useAuth } from "@/hooks/use-auth";
import {
  ApiError,
  type ArtifactListResponse,
  type RecordTypesResponse,
  type TaskListSort,
  getArtifactHistory,
  getRecord,
  getRecordHistory,
  getTaskDetail,
  getWorkCatalog,
  listArtifacts,
  listClaims,
  listJournal,
  listPresenceAll,
  listRecordTypes,
  listRecords,
  listSignalGroups,
  listSignalHistory,
  listTaskArtifactRefs,
  listTasks,
  searchArtifacts,
  searchTasks,
} from "@/lib/api";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import type {
  ArtifactSearchResponse,
  PaginatedEntityListResponse,
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
  sort?: TaskListSort;
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

/** Task types the caller may read, independent of any page of rows. */
export function useWorkCatalog(options?: { enabled?: boolean }) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["work-catalog", projectId],
    queryFn: () => getWorkCatalog(requireProjectId(projectId)),
    enabled: Boolean(projectId) && (options?.enabled ?? true),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export type TaskPageParams = {
  type: string[];
  /** Include archived tasks. The default page excludes them. */
  archived: boolean;
  sort: TaskListSort;
  order: "asc" | "desc";
  limit: number;
  cursor?: string;
};

/**
 * One keyset page of the full task list. The previous page stays on screen
 * while the next one loads, so paging does not flash an empty table.
 */
export function useTaskPage(
  params: TaskPageParams,
  options?: { enabled?: boolean },
) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["task-page", projectId, params],
    queryFn: () =>
      listTasks(requireProjectId(projectId), {
        type: params.type.length > 0 ? params.type : undefined,
        archived: params.archived ? undefined : "0",
        sort: params.sort,
        order: params.order,
        limit: params.limit,
        cursor: params.cursor,
      }) as Promise<PaginatedEntityListResponse>,
    enabled: Boolean(projectId) && (options?.enabled ?? true),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });
}

/** Minimum query length before task search is sent to the server. */
export const TASK_SEARCH_MIN_LENGTH = 2;

export function useTaskSearch(
  params: { q: string; type?: string[]; cursor?: string; limit?: number },
  options?: { enabled?: boolean },
) {
  const { projectId } = useAuth();
  const q = params.q.trim();
  return useQuery({
    queryKey: ["task-search", projectId, { ...params, q }],
    queryFn: () => searchTasks(requireProjectId(projectId), { ...params, q }),
    enabled:
      Boolean(projectId) &&
      q.length >= TASK_SEARCH_MIN_LENGTH &&
      (options?.enabled ?? true),
    placeholderData: keepPreviousData,
  });
}

/** The most recently updated non-archived tasks, for quick navigation. */
export function useRecentTasks(options?: { enabled?: boolean }) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["recent-tasks", projectId],
    queryFn: () =>
      listTasks(requireProjectId(projectId), {
        limit: 10,
        sort: "updated_at",
        order: "desc",
        archived: "0",
      }),
    enabled: Boolean(projectId) && (options?.enabled ?? true),
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

/** Unexpired signal history, newest first, paged with the server cursor. */
export function useSignalHistory() {
  const { projectId } = useAuth();
  return useInfiniteQuery({
    queryKey: ["signal-history", projectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listSignalHistory(requireProjectId(projectId), {
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: Boolean(projectId),
    refetchInterval: 5000,
  });
}

export function useSignalGroups() {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["signal-groups", projectId],
    queryFn: () => listSignalGroups(requireProjectId(projectId)),
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

export function useArtifactHistory(artifactKey: string, cursor?: string) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["artifact-history", projectId, artifactKey, cursor],
    queryFn: () =>
      getArtifactHistory(requireProjectId(projectId), artifactKey, {
        limit: 20,
        cursor,
      }),
    enabled: Boolean(projectId) && Boolean(artifactKey),
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
