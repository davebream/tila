import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { accountRequest } from "@/lib/account-api";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

export function AccountPanel({
  title,
  children,
}: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 px-6 py-12">
      <Link to="/" className="font-logo text-xl text-signal-blue">
        tila
      </Link>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}
function useLinkSecret() {
  const [secret] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }, []);
  return secret;
}
export function InvitationPage() {
  const token = useLinkSecret();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const auth = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    void accountRequest<{ email: string }>("/invitations/inspect", { token })
      .then((data) => setEmail(data.email))
      .catch((error) => setError(error.message));
  }, [token]);
  return (
    <AccountPanel title="Create your account">
      <p>{email || "Checking invitation…"}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await accountRequest("/invitations/accept", {
              token,
              name,
              password,
            });
            await auth.login(email, password);
            navigate("/", { replace: true });
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : "Could not create account",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="account-access-field-1">
          Name
          <Input
            id="account-access-field-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
          />
        </label>
        <label htmlFor="account-access-field-2">
          Password
          <Input
            id="account-access-field-2"
            type="password"
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Use at least 12 characters.
        </p>
        <Button disabled={!email || busy}>Create account</Button>
      </form>
      {error && <p role="alert">{error}</p>}
    </AccountPanel>
  );
}
export function HandoffPage() {
  const queryClient = useQueryClient();
  const token = useLinkSecret();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  useEffect(() => {
    void accountRequest<{ email: string }>("/handoff/inspect", { token })
      .then((data) => setEmail(data.email))
      .catch((error) => setError(error.message));
  }, [token]);
  return (
    <AccountPanel title="Open your CLI account">
      {email && <p>Sign in as {email}</p>}
      <p>
        Continue only if you just ran <code>tila open</code> on your own device.
        This link expires after one minute and works once.
      </p>
      <Button
        disabled={busy || !email}
        onClick={async () => {
          setBusy(true);
          try {
            await accountRequest("/auth/handoff/consume", { token });
            queryClient.clear();
            await auth.refreshStatus();
            navigate("/", { replace: true });
          } catch (error) {
            setError(
              error instanceof Error ? error.message : "Link could not be used",
            );
            setBusy(false);
          }
        }}
      >
        Continue to tila
      </Button>
      {error && (
        <p role="alert">
          {error}. Run <code>tila open</code> again.
        </p>
      )}
    </AccountPanel>
  );
}
export function DevicePage() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("user_code") ?? "");
  const [device, setDevice] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  return (
    <AccountPanel title="Authorize your CLI">
      {done ? (
        <p>Request completed. You can return to your terminal.</p>
      ) : (
        <>
          <p>
            Check that this code matches the one in your terminal. Approving
            gives this device access to your account.
          </p>
          <label htmlFor="account-access-field-3">
            Device code
            <Input
              id="account-access-field-3"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setDevice(null);
              }}
              autoComplete="off"
            />
          </label>
          {!device ? (
            <Button
              onClick={async () => {
                try {
                  const value = await accountRequest<{ client_id: string }>(
                    `/auth/device?user_code=${encodeURIComponent(code)}`,
                  );
                  setDevice(value.client_id ?? "tila CLI");
                  setError("");
                } catch (error) {
                  setError(
                    error instanceof Error ? error.message : "Invalid code",
                  );
                }
              }}
            >
              Check device
            </Button>
          ) : (
            <>
              <p>Device: {device.replace(/^tila-cli:/, "")}</p>
              <div className="flex gap-3">
                {(["approve", "deny"] as const).map((action) => (
                  <Button
                    key={action}
                    variant={action === "deny" ? "outline" : "default"}
                    onClick={async () => {
                      try {
                        await accountRequest(`/auth/device/${action}`, {
                          userCode: code,
                        });
                        setDone(true);
                      } catch (error) {
                        setError(
                          error instanceof Error
                            ? error.message
                            : "Request failed",
                        );
                      }
                    }}
                  >
                    {action === "approve" ? "Approve device" : "Deny"}
                  </Button>
                ))}
              </div>
            </>
          )}
          {error && (
            <p role="alert">
              {error}{" "}
              <Link
                to={`/login?returnTo=${encodeURIComponent(`/device?user_code=${code}`)}`}
              >
                Sign in again
              </Link>
            </p>
          )}
        </>
      )}
    </AccountPanel>
  );
}

export function RecoveryPage() {
  const queryClient = useQueryClient();
  const token = useLinkSecret();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const auth = useAuth();
  return (
    <AccountPanel title="Reset your password">
      <p>Your existing sessions will be signed out.</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await accountRequest("/recovery/accept", { token, password });
            queryClient.clear();
            await auth.refreshStatus();
            navigate("/login", { replace: true });
          } catch (error) {
            setError(
              error instanceof Error ? error.message : "Recovery failed",
            );
            setBusy(false);
          }
        }}
      >
        <label htmlFor="account-access-field-4">
          New password
          <Input
            id="account-access-field-4"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <Button disabled={busy}>Reset password</Button>
      </form>
      {error && <p role="alert">{error}</p>}
    </AccountPanel>
  );
}
