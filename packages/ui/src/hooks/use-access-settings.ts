import { isStepUpRequired } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import {
  getProjectSettings,
  listRepoLinks,
  listRuntimeEnrollments,
  listRuntimeInvitations,
  listServiceAccounts,
  listWorkloadBindings,
} from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

// Queries for the owner-level Settings editors (#298). Each read is enabled
// only when the session flag for its editor is set, so a session without the
// right never issues the request; the server checks every write again.

export function useProjectSettings() {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: () => getProjectSettings(projectId as string),
    enabled: Boolean(projectId),
  });
}

export function useRepoLinks(enabled: boolean) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["repo-links", projectId],
    queryFn: () => listRepoLinks(),
    enabled: Boolean(projectId) && enabled,
  });
}

/** Shares its cache with the Access page's service-account labels. */
export function useServiceAccountList(enabled: boolean) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["service-accounts", projectId],
    queryFn: () => listServiceAccounts(projectId as string),
    enabled: Boolean(projectId) && enabled,
  });
}

export function useWorkloadBindings(principalId: string, enabled: boolean) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["workload-bindings", projectId, principalId],
    queryFn: () => listWorkloadBindings(projectId as string, principalId),
    enabled: Boolean(projectId) && enabled,
  });
}

/** Owners see every installation; other members only those they sponsor. */
export function useRuntimeEnrollments() {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["runtime-enrollments", projectId],
    queryFn: () => listRuntimeEnrollments(projectId as string),
    enabled: Boolean(projectId),
  });
}

/** Owner-only; listed invitations never include their secret. */
export function useRuntimeInvitations(enabled: boolean) {
  const { projectId } = useAuth();
  return useQuery({
    queryKey: ["runtime-invitations", projectId],
    queryFn: () => listRuntimeInvitations(projectId as string),
    enabled: Boolean(projectId) && enabled,
  });
}

/** Re-read what an access write may have changed, by key prefix. */
export function useInvalidateAccess() {
  const client = useQueryClient();
  const { projectId } = useAuth();
  const invalidate = (...keys: string[]) =>
    Promise.all(
      keys.map((key) =>
        client.invalidateQueries({ queryKey: [key, projectId] }),
      ),
    );
  return {
    project: () => invalidate("project-settings"),
    repos: () => invalidate("repo-links", "membership-repos"),
    services: () =>
      invalidate("service-accounts", "workload-bindings", "memberships"),
    runtime: () =>
      invalidate(
        "runtime-enrollments",
        "runtime-invitations",
        "runtime-view",
        "agents",
      ),
    access: () => invalidate("whoami"),
  };
}

/**
 * Page-level state for `step-up-required`: an owner write from a session
 * older than the step-up window was refused, so the page asks the user to sign
 * in again and then repeat the change.
 */
export function useStepUp() {
  const [required, setRequired] = useState(false);
  return {
    required,
    /** Show the banner when `error` is a step-up demand; true if it was. */
    caught(error: unknown): boolean {
      if (!isStepUpRequired(error)) return false;
      setRequired(true);
      return true;
    },
    dismiss: () => setRequired(false),
  };
}
