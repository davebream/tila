import { useWhoami } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import {
  DEFINITIONS_ACCESS,
  isRestricted,
  navVisibility,
} from "@/lib/navigation";
import type { CredentialPolicy, WhoamiResponse } from "@tila/schemas";

export interface ReadinessAccess {
  /** Settings › Definitions, or null when the caller's access excludes it. */
  definitionsHref: string | null;
  /** The credential carries a task-type or record restriction. */
  restricted: boolean;
  /** The credential sees only some task types (`task_types`). */
  taskTypesRestricted: boolean;
}

/**
 * What the readiness note may link to and say. `known` is whether the identity
 * has been read: until then no link is offered, so the note never points a
 * caller at a page their credential turns out not to reach.
 */
export function readinessAccess(
  identity: WhoamiResponse | undefined,
  projectId: string | null,
  known: boolean,
): ReadinessAccess {
  const canUse = navVisibility(identity, projectId);
  const own = identity?.project_id === projectId;
  const policy = own
    ? (identity?.policy as CredentialPolicy | undefined)
    : undefined;
  return {
    definitionsHref:
      projectId && known && canUse(DEFINITIONS_ACCESS)
        ? `/p/${encodeURIComponent(projectId)}/settings/definitions`
        : null,
    restricted: own && isRestricted(identity),
    taskTypesRestricted: policy?.restrictions?.task_types !== undefined,
  };
}

export function useReadinessAccess(): ReadinessAccess {
  const { projectId } = useAuth();
  const identity = useWhoami();
  return readinessAccess(
    identity.data,
    projectId,
    identity.isSuccess || identity.isError,
  );
}
