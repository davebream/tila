import { DefaultRedirect } from "@/components/admin/step-up-resume";
import { PROJECT_SEGMENTS } from "@/lib/navigation";
import { Navigate, useLocation } from "react-router";

/**
 * Flat URLs from before project-scoped routes (`/tasks/:id`, `/rooms/:id`,
 * `/entities/:id`, ...). Rewrites them below the active project and keeps the
 * sub-path, query and fragment, so old bookmarks open the same view. Anything
 * else falls through to the default project page. Every redirect replaces the
 * history entry, so Back skips the alias.
 */
export function LegacyRedirect({ projectId }: { projectId: string }) {
  const { pathname, search, hash } = useLocation();
  const [first = "", ...rest] = pathname.replace(/^\/+/, "").split("/");
  if (!PROJECT_SEGMENTS.has(first))
    return <DefaultRedirect projectId={projectId} />;
  const segment = first === "entities" ? "tasks" : first;
  const tail = rest.length > 0 ? `/${rest.join("/")}` : "";
  return (
    <Navigate
      to={`/p/${projectId}/${segment}${tail}${search}${hash}`}
      replace
    />
  );
}

/** `/p/:projectId/entities[/:id]` is the pre-rename name for tasks. */
export function EntityAlias({ projectId }: { projectId: string }) {
  const { pathname, search, hash } = useLocation();
  const tail = pathname.replace(/^.*?\/entities(?=\/|$)/, "");
  return (
    <Navigate to={`/p/${projectId}/tasks${tail}${search}${hash}`} replace />
  );
}
