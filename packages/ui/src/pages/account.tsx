import { AccountTokens } from "@/components/account-tokens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  type AccountInfo,
  type AccountUser,
  accountRequest,
} from "@/lib/account-api";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { AccountPanel } from "./account-access";

export function AccountPage() {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [invitations, setInvitations] = useState<
    { id: string; email: string; expiresAt: number }[]
  >([]);
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectRole, setProjectRole] = useState("participant");
  const [role, setRole] = useState("user");
  const [invitation, setInvitation] = useState("");
  const [emailDelivery, setEmailDelivery] = useState(false);
  const [sendEmail, setSendEmail] = useState(false);
  const [github, setGithub] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const auth = useAuth();
  const refresh = useCallback(async () => {
    const data = await accountRequest<AccountInfo>("/me");
    setInfo(data);
    if (data.user.role === "admin") {
      setInvitations(
        (
          await accountRequest<{
            invitations: { id: string; email: string; expiresAt: number }[];
          }>("/admin/invitations")
        ).invitations,
      );
      setUsers(
        (await accountRequest<{ users: AccountUser[] }>("/admin/users")).users,
      );
    }
  }, []);
  async function run(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed");
    }
  }
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
    void accountRequest<{ emailDelivery: boolean; github: boolean }>(
      "/config",
    ).then((config) => {
      setEmailDelivery(config.emailDelivery);
      setGithub(config.github);
    });
  }, [refresh]);
  return (
    <AccountPanel title="Your account">
      {error && (
        <p role="alert" className="text-status-red">
          {error}{" "}
          <Link className="underline" to="/login">
            Sign in again
          </Link>
        </p>
      )}
      {info && (
        <>
          <p>
            {info.user.name} · {info.user.email} · {info.user.role}
          </p>
          <h2 className="text-lg font-medium">Devices and sessions</h2>
          <ul className="space-y-3">
            {info.sessions.map((session) => (
              <li
                key={session.id}
                className="flex items-center justify-between gap-3 rounded border p-3"
              >
                <div>
                  <p>
                    {session.device
                      ? session.name || "CLI device"
                      : "Browser session"}
                    {session.id === info.sessionId ? " (this session)" : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(session.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() =>
                    run(async () => {
                      await accountRequest(
                        `/sessions/${session.id}`,
                        undefined,
                        "DELETE",
                      );
                      if (session.id === info.sessionId)
                        await auth.refreshStatus();
                    })
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Revoking a CLI device also signs out browsers opened from that
            device.
          </p>
          <AccountTokens />
          <h2 className="text-lg font-medium">Change password</h2>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await accountRequest("/auth/change-password", {
                  currentPassword,
                  newPassword,
                  revokeOtherSessions: true,
                });
                setCurrentPassword("");
                setNewPassword("");
              });
            }}
          >
            <label htmlFor="account-field-1">
              Current password
              <Input
                id="account-field-1"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </label>
            <label htmlFor="account-field-2">
              New password
              <Input
                id="account-field-2"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </label>
            <Button>Change password and sign out other sessions</Button>
          </form>
          {github && (
            <Button
              variant="outline"
              onClick={() =>
                run(async () => {
                  const data = await accountRequest<{ url: string }>(
                    "/auth/link-social",
                    {
                      provider: "github",
                      callbackURL: new URL("/account", window.location.origin)
                        .href,
                    },
                  );
                  window.location.assign(data.url);
                })
              }
            >
              Link your GitHub account
            </Button>
          )}
          {info.user.role === "admin" && (
            <>
              <h2 className="text-lg font-medium">Invite a user</h2>
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const result = await accountRequest<{
                      url: string;
                      emailSent: boolean;
                    }>("/admin/invitations", {
                      email,
                      role,
                      projectId: projectId || undefined,
                      projectRole,
                      sendEmail,
                    });
                    setInvitation(result.url);
                    if (sendEmail && !result.emailSent)
                      setError(
                        "Email could not be sent. Share the invitation link below.",
                      );
                  });
                }}
              >
                <label htmlFor="account-field-3">
                  Email
                  <Input
                    id="account-field-3"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Account role
                  <select
                    className="ml-3 rounded border bg-background p-2"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="user">User</option>
                    <option value="admin">Administrator</option>
                  </select>
                </label>
                <label htmlFor="account-field-4">
                  Project ID (optional)
                  <Input
                    id="account-field-4"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                  />
                </label>
                <label>
                  Project role
                  <select
                    className="ml-3 rounded border bg-background p-2"
                    value={projectRole}
                    onChange={(e) => setProjectRole(e.target.value)}
                  >
                    {["viewer", "participant", "maintainer", "owner"].map(
                      (role) => (
                        <option key={role}>{role}</option>
                      ),
                    )}
                  </select>
                </label>
                {emailDelivery && (
                  <label>
                    <input
                      type="checkbox"
                      checked={sendEmail}
                      onChange={(e) => setSendEmail(e.target.checked)}
                    />{" "}
                    Send invitation by email
                  </label>
                )}
                <Button>Create invitation</Button>
              </form>
              {invitation && (
                <div className="space-y-2 rounded border p-3">
                  <p>
                    Share this link privately. Invitations expire in 7 days;
                    recovery links expire in one hour.
                  </p>
                  <Input
                    aria-label="Invitation link"
                    value={invitation}
                    readOnly
                  />
                  <Button
                    variant="outline"
                    onClick={() => navigator.clipboard.writeText(invitation)}
                  >
                    Copy invitation
                  </Button>
                </div>
              )}
              <h2 className="text-lg font-medium">Pending invitations</h2>
              <ul className="space-y-2">
                {invitations.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex justify-between gap-3 rounded border p-3"
                  >
                    <span>
                      {invite.email} · expires{" "}
                      {new Date(invite.expiresAt).toLocaleDateString()}
                    </span>
                    <Button
                      variant="outline"
                      onClick={() =>
                        run(() =>
                          accountRequest(
                            `/admin/invitations/${invite.id}`,
                            undefined,
                            "DELETE",
                          ),
                        )
                      }
                    >
                      Revoke invitation
                    </Button>
                  </li>
                ))}
              </ul>
              <h2 className="text-lg font-medium">Users</h2>
              <ul className="space-y-3">
                {users.map((user) => (
                  <li key={user.id} className="space-y-2 rounded border p-3">
                    <p>
                      {user.email} · {user.role}
                      {user.disabled ? " · suspended" : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      User ID: {user.id}
                    </p>
                    <Button
                      variant="outline"
                      disabled={user.disabled}
                      onClick={() =>
                        run(async () => {
                          const result = await accountRequest<{ url: string }>(
                            "/admin/recovery",
                            { email: user.email },
                          );
                          setInvitation(result.url);
                        })
                      }
                    >
                      Create recovery link
                    </Button>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() =>
                          run(() =>
                            accountRequest(
                              `/admin/users/${user.id}`,
                              { disabled: !user.disabled },
                              "PATCH",
                            ),
                          )
                        }
                      >
                        {user.disabled ? "Enable" : "Suspend"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() =>
                          run(() =>
                            accountRequest(
                              `/admin/users/${user.id}`,
                              {
                                role: user.role === "admin" ? "user" : "admin",
                              },
                              "PATCH",
                            ),
                          )
                        }
                      >
                        {user.role === "admin"
                          ? "Remove admin role"
                          : "Make administrator"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Button variant="outline" onClick={() => auth.logout()}>
            Sign out
          </Button>
        </>
      )}
    </AccountPanel>
  );
}
