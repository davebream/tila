import { useAuth } from "@/hooks/use-auth";
import { workspaceSelect } from "@/lib/api";
import { peekStepUpResume, takeStepUpResume } from "@/lib/step-up";
import { useEffect, useRef } from "react";
import { Navigate } from "react-router";

/**
 * Step-up resume, part 1 (#102). GitHub sign-in lands on `/` with a
 * workspace session and no selected project. When a resume stash exists,
 * reselect the project; `DefaultRedirect` then consumes the stash and
 * returns to the settings page. Rendered only while no project is active.
 * Mutations are never replayed automatically.
 */
export function StepUpResume() {
  const { isAuthenticated, isLoading, projectId, selectProject } = useAuth();
  const running = useRef(false);

  useEffect(() => {
    if (isLoading || !isAuthenticated || projectId || running.current) return;
    const stash = peekStepUpResume();
    if (!stash) return;
    running.current = true;
    (async () => {
      try {
        await workspaceSelect(stash.projectId);
        selectProject(stash.projectId);
      } catch {
        // Selection failed (membership revoked, project gone): drop the
        // stash and leave the user on the workspace page.
        takeStepUpResume();
      } finally {
        running.current = false;
      }
    })();
  }, [isAuthenticated, isLoading, projectId, selectProject]);

  return null;
}

/**
 * Step-up resume, part 2. Used for `/` and unknown paths once a project is
 * active: if a resume stash targets this project, go back to where the user
 * was; otherwise go to the default page.
 */
export function DefaultRedirect({ projectId }: { projectId: string }) {
  const stash = peekStepUpResume();
  if (stash && stash.projectId === projectId) {
    takeStepUpResume();
    return <Navigate to={stash.returnTo} replace />;
  }
  if (stash) takeStepUpResume();
  return <Navigate to={`/p/${projectId}/tasks`} replace />;
}
