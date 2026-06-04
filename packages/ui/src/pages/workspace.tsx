import { TilaMark } from "@/components/layout";
import { useAuth } from "@/hooks/use-auth";
import { ApiError, workspaceProjects, workspaceSelect } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return "Cannot reach server";
  return err instanceof Error ? err.message : "Failed to load projects";
}

export function WorkspacePage() {
  const { logout, selectProject } = useAuth();
  const navigate = useNavigate();
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  const {
    data: projects,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["workspace-projects"],
    queryFn: async () => (await workspaceProjects()).projects,
  });

  async function handleSelect(projectId: string) {
    setSelecting(projectId);
    setSelectError(null);
    try {
      await workspaceSelect(projectId);
      selectProject(projectId);
      navigate(`/p/${projectId}/tasks`);
    } catch (err) {
      setSelectError(errorMessage(err));
      setSelecting(null);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-2">
          <div className="flex items-center gap-2 text-signal-blue">
            <TilaMark size={22} />
            <span className="font-logo text-2xl tracking-tight">tila</span>
          </div>
          <h1 className="text-sm text-muted-foreground mt-1">
            Select a project
          </h1>
        </div>

        {(error || selectError) && (
          <div
            role="alert"
            className="flex items-start gap-2 text-sm text-status-red mb-4"
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="mt-0.5 shrink-0"
            >
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zM7.25 5a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0V5zM8 10.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"
                clipRule="evenodd"
              />
            </svg>
            <span>{selectError || errorMessage(error)}</span>
          </div>
        )}

        {isLoading && (
          <div className="text-center text-muted-foreground text-sm py-8">
            Loading projects...
          </div>
        )}

        {!isLoading && projects && projects.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No accessible projects found. Make sure your GitHub account has
            access to a tila project.
          </div>
        )}

        {!isLoading && projects && projects.length > 0 && (
          <div className="border border-border rounded-sm overflow-hidden">
            {projects.map((project, i) => (
              <button
                key={project.projectId}
                type="button"
                disabled={selecting !== null}
                className={`w-full flex items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-card cursor-pointer disabled:cursor-wait ${i > 0 ? "border-t border-border" : ""}`}
                onClick={() => handleSelect(project.projectId)}
              >
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate">
                    {project.displayName || project.projectId}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                    {project.repos
                      .map((r) => `${r.owner}/${r.repo}`)
                      .join(", ")}
                  </div>
                </div>
                <div className="shrink-0 text-muted-foreground">
                  {selecting === project.projectId ? (
                    <span className="text-xs text-signal-blue">
                      Connecting...
                    </span>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-center">
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => logout()}
          >
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
