import { DefaultRedirect } from "@/components/admin/step-up-resume";
import { PROJECT_SEGMENTS, defaultProjectPath } from "@/lib/navigation";
import { Navigate, useLocation, useParams } from "react-router";

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

/**
 * `/p/:projectId/entities[/:id]` is the pre-rename name for tasks. The project
 * in the URL is kept, so a shared link never silently moves to another one.
 */
export function EntityAlias({ projectId }: { projectId: string }) {
  const { pathname, search, hash } = useLocation();
  const project = useParams().projectId ?? projectId;
  const tail = pathname.replace(/^.*?\/entities(?=\/|$)/, "");
  return <Navigate to={`/p/${project}/tasks${tail}${search}${hash}`} replace />;
}

/** The project's default page, for the project in the URL. */
export function ProjectHome({ projectId }: { projectId: string }) {
  const project = useParams().projectId ?? projectId;
  return <Navigate to={defaultProjectPath(project)} replace />;
}
