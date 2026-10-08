import { useAuth } from "@/hooks/use-auth";
import { workspaceSelect } from "@/lib/api";
import { peekStepUpResume, takeStepUpResume } from "@/lib/step-up";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

/**
 * After a step-up sign-in the app lands on `/`. If a resume stash exists,
 * reselect the project (GitHub sign-in yields a workspace session) and return
 * to the settings page. Rendered inside the auth gate once the session is
 * known. Mutations are never replayed automatically.
 */
export function StepUpResume() {
  const { isAuthenticated, isLoading, projectId, selectProject } = useAuth();
  const navigate = useNavigate();
  const running = useRef(false);

  useEffect(() => {
    if (isLoading || !isAuthenticated || running.current) return;
    const pending = peekStepUpResume();
    if (!pending) return;
    running.current = true;
    const stash = takeStepUpResume();
    if (!stash) {
      running.current = false;
      return;
    }
    (async () => {
      try {
        if (projectId === stash.projectId) {
          navigate(stash.returnTo, { replace: true });
          return;
        }
        if (!projectId) {
          await workspaceSelect(stash.projectId);
          selectProject(stash.projectId);
          navigate(stash.returnTo, { replace: true });
        }
        // A different project is active: leave the user where they are.
      } catch {
        // Selection failed (membership revoked, project gone): fall through
        // to the workspace page, which lists what the user can still open.
      } finally {
        running.current = false;
      }
    })();
  }, [isAuthenticated, isLoading, projectId, selectProject, navigate]);

  return null;
}
