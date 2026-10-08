import { useAuth } from "@/hooks/use-auth";
import {
  ApiError,
  getMembershipPolicy,
  grantMembership,
  listMembershipEvents,
  listMembershipRepos,
  listMemberships,
  listServiceAccounts,
  listTokens,
  revokeMembership,
  revokeToken,
  setMembershipPolicy,
  updateMembershipRole,
  whoami,
} from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MembershipGrantRequest,
  ProjectMembershipMode,
  ProjectRole,
} from "@tila/schemas";

// Queries and mutations for the project settings panel (#102). Every query is
// enabled only when the server-computed capability allows it, so a session
// without management rights never issues the request.

function requireProjectId(projectId: string | null): string {
  if (!projectId) throw new ApiError("not-configured", "No active session.");
  return projectId;
}

export function useAdminCapabilities() {
  const { capabilities, projectId } = useAuth();
  return {
    projectId,
    capabilities,
    canManageMemberships: capabilities?.memberships_manage === true,
    canManageCredentials: capabilities?.credentials_manage === true,
    membershipAvailable: capabilities?.membership_available !== false,
  };
}

export function useWhoami() {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["whoami", projectId],
    queryFn: () => whoami(),
    enabled: Boolean(projectId),
  });
}

export function useMembershipPolicy() {
  const { projectId, canManageMemberships } = useAdminCapabilities();
  return useQuery({
    queryKey: ["membership-policy", projectId],
    queryFn: () => getMembershipPolicy(requireProjectId(projectId)),
    enabled: Boolean(projectId) && canManageMemberships,
  });
}

export function useMemberships(includeRevoked = true) {
  const { projectId, canManageMemberships } = useAdminCapabilities();
  return useQuery({
    queryKey: ["memberships", projectId, includeRevoked],
    queryFn: () =>
      listMemberships(requireProjectId(projectId), { includeRevoked }),
    enabled: Boolean(projectId) && canManageMemberships,
  });
}

export function useMembershipEvents(limit = 20) {
  const { projectId, canManageMemberships } = useAdminCapabilities();
  return useQuery({
    queryKey: ["membership-events", projectId, limit],
    queryFn: () => listMembershipEvents(requireProjectId(projectId), { limit }),
    enabled: Boolean(projectId) && canManageMemberships,
  });
}

export function useMembershipRepos() {
  const { projectId, canManageMemberships } = useAdminCapabilities();
  return useQuery({
    queryKey: ["membership-repos", projectId],
    queryFn: () => listMembershipRepos(requireProjectId(projectId)),
    enabled: Boolean(projectId) && canManageMemberships,
  });
}

export function useServiceAccounts() {
  const { projectId, canManageMemberships, canManageCredentials } =
    useAdminCapabilities();
  return useQuery({
    queryKey: ["service-accounts", projectId],
    queryFn: () => listServiceAccounts(requireProjectId(projectId)),
    enabled:
      Boolean(projectId) && (canManageMemberships || canManageCredentials),
  });
}

export function useTokens() {
  const { projectId, canManageCredentials } = useAdminCapabilities();
  return useQuery({
    queryKey: ["tokens", projectId],
    queryFn: () => listTokens(),
    enabled: Boolean(projectId) && canManageCredentials,
  });
}

const MEMBERSHIP_KEYS = [
  "memberships",
  "membership-events",
  "membership-policy",
  "whoami",
] as const;

function useInvalidate(keys: readonly string[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      keys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
    );
}

export function useGrantMembership() {
  const { projectId } = useAuth();
  const invalidate = useInvalidate(MEMBERSHIP_KEYS);
  return useMutation({
    mutationFn: (body: MembershipGrantRequest) =>
      grantMembership(requireProjectId(projectId), body),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateMembershipRole() {
  const { projectId } = useAuth();
  const invalidate = useInvalidate(MEMBERSHIP_KEYS);
  return useMutation({
    mutationFn: (vars: { membershipId: string; role: ProjectRole }) =>
      updateMembershipRole(
        requireProjectId(projectId),
        vars.membershipId,
        vars.role,
      ),
    onSuccess: () => invalidate(),
  });
}

export function useRevokeMembership() {
  const { projectId } = useAuth();
  const invalidate = useInvalidate([...MEMBERSHIP_KEYS, "tokens"]);
  return useMutation({
    mutationFn: (membershipId: string) =>
      revokeMembership(requireProjectId(projectId), membershipId),
    onSuccess: () => invalidate(),
  });
}

export function useSetMembershipPolicy() {
  const { projectId } = useAuth();
  const invalidate = useInvalidate(MEMBERSHIP_KEYS);
  return useMutation({
    mutationFn: (mode: ProjectMembershipMode) =>
      setMembershipPolicy(requireProjectId(projectId), mode),
    onSuccess: () => invalidate(),
  });
}

export function useRevokeToken() {
  const invalidate = useInvalidate(["tokens"]);
  return useMutation({
    mutationFn: (name: string) => revokeToken(name),
    onSuccess: () => invalidate(),
  });
}

/** True when a mutation failed because the session must re-authenticate. */
export function isStepUpRequired(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "step-up-required";
}
