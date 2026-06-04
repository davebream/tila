import { TilaMark } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { ApiError } from "@/lib/api";
import { API_BASE_URL } from "@/lib/config";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";

const PROJECT_ID_KEY = "tila:last-project-id";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "http-401")
      return "Invalid token. Check with your project admin or use Connect with GitHub.";
    if (err.code === "http-404")
      return "Project not found. Verify the project ID with your admin.";
    if (err.code === "http-429") return "Too many attempts, try again shortly.";
    return err.message;
  }
  if (err instanceof TypeError)
    return "Cannot reach server. Is the backend running?";
  return err instanceof Error ? err.message : "Connection failed";
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(() => {
    try {
      return localStorage.getItem(PROJECT_ID_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    if (!isRedirecting) return;
    const timer = setTimeout(() => {
      setIsRedirecting(false);
      setError("Redirect did not complete. Try again or use an API token.");
    }, 5000);
    return () => clearTimeout(timer);
  }, [isRedirecting]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (token && !token.startsWith("tila_")) {
      setError("Tokens start with tila_. Check the value you were given.");
      return;
    }

    setIsSubmitting(true);

    try {
      await auth.login(projectId, token);
      localStorage.setItem(PROJECT_ID_KEY, projectId);
      navigate("/tasks", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center">
          <div className="flex items-center gap-2 text-signal-blue">
            <TilaMark size={22} />
            <span className="font-logo text-2xl tracking-tight">tila</span>
          </div>
          <CardTitle className="mt-2 text-center font-logo text-xl font-medium tracking-tight text-foreground">
            Connect to a project
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="w-full cursor-pointer"
            onClick={() => {
              if (isRedirecting) {
                setIsRedirecting(false);
                setError(null);
              } else {
                setIsRedirecting(true);
                setError(null);
                window.location.href = `${API_BASE_URL}/api/auth/github/login`;
              }
            }}
          >
            {isRedirecting ? "Cancel redirect" : "Connect with GitHub"}
          </Button>

          <div className="my-4 flex flex-col items-center gap-1">
            <div className="flex w-full items-center gap-2">
              <div className="h-px flex-1 bg-muted-foreground/20" />
              <span className="text-xs text-muted-foreground">
                or use API token
              </span>
              <div className="h-px flex-1 bg-muted-foreground/20" />
            </div>
            <span className="text-[11px] text-muted-foreground/60">
              For CI, scripts, or when GitHub is unavailable
            </span>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="project-id"
                className="text-sm text-muted-foreground"
              >
                Project ID
              </label>
              <Input
                id="project-id"
                type="text"
                autoFocus
                autoComplete="off"
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setError(null);
                }}
                placeholder="my-project"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="api-token"
                className="text-sm text-muted-foreground"
              >
                API Token
              </label>
              <div className="relative">
                <Input
                  id="api-token"
                  type={showToken ? "text" : "password"}
                  autoComplete="off"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setError(null);
                  }}
                  placeholder="tila_..."
                  className="pr-10 font-mono"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute top-1/2 right-3 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 outline-none"
                  aria-label={showToken ? "Hide token" : "Show token"}
                >
                  {showToken ? (
                    <svg
                      aria-hidden="true"
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2 2l12 12M6.5 6.5a2 2 0 0 0 3 3M2.5 8.5C3.5 10 5.5 12 8 12c1 0 1.9-.3 2.7-.7M13.5 7.5C12.5 6 10.5 4 8 4c-1 0-1.9.3-2.7.7" />
                    </svg>
                  ) : (
                    <svg
                      aria-hidden="true"
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M8 4C5.5 4 3.5 6 2.5 8c1 2 3 4 5.5 4s4.5-2 5.5-4c-1-2-3-4-5.5-4z" />
                      <circle cx="8" cy="8" r="2" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Ask your project admin for a token, or use Connect with GitHub
                above.
              </p>
            </div>
            <div role="alert" aria-live="assertive" className="min-h-0">
              {error && (
                <div className="flex items-start gap-2 text-sm text-status-red">
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
                  <span>{error}</span>
                </div>
              )}
            </div>
            <Button
              type="submit"
              className="cursor-pointer"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Connecting..." : "Connect"}
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            New to tila?{" "}
            <a
              href="https://github.com/davebream/tila#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="text-signal-blue hover:text-signal-blue-hover underline underline-offset-2"
            >
              Getting started
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
