import { useWhoami } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import {
  agentArchivePreview,
  getRoom,
  listAgents,
  listRooms,
  roomArchivePreview,
} from "@/lib/api";
import { failureKind } from "@/lib/mutation-errors";
import { rights } from "@/lib/rights";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

// Queries and commands for Settings › Agents, Rooms and Signal groups (#298).
// Reads and writes never depend on the membership-admin capabilities; the
// controls follow `rights()` and the server enforces every write again.

/** The caller's rights in this project, and whether they are known yet. */
export function useProjectRights() {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const whoami = useWhoami();
  return {
    project,
    whoami,
    allowed: rights(whoami.data, project),
    /** False until the identity answered (or failed): controls stay absent. */
    known: !whoami.isPending,
  };
}

/** Managers ask for archived agents too; the server ignores it for others. */
export function useAgentSettings(options: {
  includeArchived: boolean;
  enabled: boolean;
}) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: [
      "agents",
      projectId,
      { includeArchived: options.includeArchived },
    ],
    queryFn: () =>
      listAgents(projectId as string, {
        includeArchived: options.includeArchived,
      }),
    enabled: Boolean(projectId) && options.enabled,
    refetchInterval: 10_000,
  });
}

/** What archiving would affect now. Always re-read when a dialog opens. */
export function useAgentArchivePreview(id: string | null) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["agent-archive-preview", projectId, id],
    queryFn: () => agentArchivePreview(projectId as string, id as string),
    enabled: Boolean(projectId) && Boolean(id),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** Every readable room, archived ones included. */
export function useRoomSettings() {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["rooms", projectId, { includeArchived: true }],
    queryFn: () => listRooms(projectId as string, { includeArchived: true }),
    enabled: Boolean(projectId),
    refetchInterval: 10_000,
  });
}

/** One room with its members; shares the cache with the Rooms page. */
export function useRoomDetail(id: string | null) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["room", projectId, id],
    queryFn: () => getRoom(projectId as string, id as string),
    enabled: Boolean(projectId) && Boolean(id),
    refetchInterval: 10_000,
  });
}

export function useRoomArchivePreview(id: string | null) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["room-archive-preview", projectId, id],
    queryFn: () => roomArchivePreview(projectId as string, id as string),
    enabled: Boolean(projectId) && Boolean(id),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** Re-read everything a settings write may have changed, by key prefix. */
export function useInvalidateSettings() {
  const client = useQueryClient();
  const { projectId } = useAuth();
  const invalidate = (...keys: string[]) =>
    Promise.all(
      keys.map((key) =>
        client.invalidateQueries({ queryKey: [key, projectId] }),
      ),
    );
  return {
    agents: () => invalidate("agents", "agent-archive-preview", "runtime-view"),
    rooms: () => invalidate("rooms", "room", "room-archive-preview"),
    groups: () => invalidate("signal-groups"),
    access: () => invalidate("whoami"),
  };
}

/**
 * One immediate command (archive, unarchive, a member change, a delete). Each
 * send gets a new idempotency key; after an unconfirmed failure (no answer, a
 * server fault) `retry` resends the same request with the same key, so the
 * server's receipt answers instead of applying it twice. Any other failure
 * forgets the request.
 */
export function useRetryableCommand<A, R>(
  run: (args: A, idempotencyKey: string) => Promise<R>,
  handlers: {
    onSuccess?: (result: R, args: A) => void;
    onError?: (error: unknown, args: A) => void;
  } = {},
) {
  const [staged, setStaged] = useState<{ args: A; key: string } | null>(null);
  const mutation = useMutation({
    networkMode: "always",
    mutationFn: (command: { args: A; key: string }) =>
      run(command.args, command.key),
    onSuccess: (result, command) => {
      setStaged(null);
      handlers.onSuccess?.(result, command.args);
    },
    onError: (error, command) => {
      if (failureKind(error) !== "unconfirmed") setStaged(null);
      handlers.onError?.(error, command.args);
    },
  });
  return {
    send(args: A) {
      const command = { args, key: crypto.randomUUID() };
      setStaged(command);
      mutation.mutate(command);
    },
    retry() {
      if (staged) mutation.mutate(staged);
    },
    /** The request awaiting a retry after an unconfirmed failure. */
    unconfirmed: staged && mutation.isError ? staged.args : null,
    /** The request in flight or awaiting a retry. */
    target: staged?.args ?? null,
    pending: mutation.isPending,
    error: mutation.error as unknown,
    reset() {
      setStaged(null);
      mutation.reset();
    },
  };
}
