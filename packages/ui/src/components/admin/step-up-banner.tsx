import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { API_BASE_URL } from "@/lib/config";
import { stashStepUpResume } from "@/lib/step-up";
import { useLocation, useNavigate } from "react-router";

/**
 * Shown when a mutation was rejected with `step-up-required`. Sends the user
 * through sign-in again and arranges for the panel to be reopened afterwards.
 */
export function StepUpBanner({ onDismiss }: { onDismiss: () => void }) {
  const { projectId, capabilities } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const minutes = Math.max(
    1,
    Math.round((capabilities?.step_up_max_age_seconds ?? 600) / 60),
  );

  function reauthenticate() {
    if (!projectId) return;
    stashStepUpResume({
      projectId,
      returnTo: `${location.pathname}${location.search}${location.hash}`,
    });
    if (capabilities?.auth_method === "token") {
      navigate("/login");
      return;
    }
    window.location.href = `${API_BASE_URL}/api/auth/github/login`;
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-tint-amber px-4 py-3"
    >
      <div className="space-y-0.5">
        <p className="text-sm text-foreground">Re-authenticate to continue</p>
        <p className="text-xs text-muted-foreground">
          Membership and credential changes require a sign-in newer than{" "}
          {minutes} minute{minutes === 1 ? "" : "s"}. Your change was not
          applied.
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button size="sm" onClick={reauthenticate}>
          Sign in again
        </Button>
      </div>
    </div>
  );
}
