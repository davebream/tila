import { TilaMark } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { accountRequest } from "@/lib/account-api";
import { type FormEvent, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [github, setGithub] = useState(false);
  useEffect(() => {
    void accountRequest<{ github: boolean }>("/config")
      .then((config) => setGithub(config.github === true))
      .catch(() => {});
  }, []);
  const requested = new URLSearchParams(location.search).get("returnTo");
  const destination =
    location.pathname === "/device"
      ? location.pathname + location.search
      : requested?.startsWith("/") && !requested.startsWith("//")
        ? requested
        : "/";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(email, password);
      navigate(destination, { replace: true });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center">
          <div className="flex items-center gap-2 text-signal-blue">
            <TilaMark size={22} />
            <span className="font-logo text-2xl">tila</span>
          </div>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          {auth.migrationRequired && (
            <div role="alert" className="mb-4 space-y-3 text-sm">
              <p>
                Your old API-token browser session needs an account with project
                access. Sign in below, or ask your administrator for an
                invitation that includes project membership. Retrying the old
                session will not restore access.
              </p>
              <details>
                <summary className="cursor-pointer">
                  First administrator setup
                </summary>
                <p className="mt-2">
                  On the provisioning machine, the infrastructure owner can run:
                </p>
                <code className="mt-2 block break-words">
                  tila auth setup --url &lt;instance-url&gt; --email
                  &lt;email&gt; --project &lt;project-id&gt;
                </code>
                <p className="mt-2">
                  This requires the infrastructure owner credential. A project
                  API token cannot create an instance administrator.
                </p>
              </details>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await auth.logout();
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Sign-out failed",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Sign out of old session
              </Button>
            </div>
          )}
          <form onSubmit={submit} className="flex flex-col gap-4">
            <label htmlFor="login-field-1" className="text-sm">
              Email
              <Input
                id="login-field-1"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label htmlFor="login-field-2" className="text-sm">
              Password
              <Input
                id="login-field-2"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-status-red">
                {error}
              </p>
            )}
            <Button disabled={busy} type="submit">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          {github && (
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={async () => {
                try {
                  const result = await accountRequest<{ url: string }>(
                    "/auth/sign-in/social",
                    {
                      provider: "github",
                      callbackURL: new URL(destination, window.location.origin)
                        .href,
                    },
                  );
                  window.location.assign(result.url);
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "GitHub sign-in failed",
                  );
                }
              }}
            >
              Sign in with GitHub
            </Button>
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            Need an account or help signing in? Ask your administrator for an
            invitation or account recovery.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
