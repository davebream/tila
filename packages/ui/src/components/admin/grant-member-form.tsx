import { PROJECT_ROLES } from "@/components/admin/role-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, type ServiceAccount, githubUserLookup } from "@/lib/api";
import type {
  MembershipGrantRequest,
  ProjectMembership,
  ProjectRole,
} from "@tila/schemas";
import { useId, useState } from "react";

type Provider = "github" | "service" | "oidc";

interface GrantMemberFormProps {
  serviceAccounts: ServiceAccount[];
  memberships: ProjectMembership[];
  pending: boolean;
  onGrant: (
    body: MembershipGrantRequest,
  ) => Promise<{ created: boolean; membership: ProjectMembership }>;
}

const inputClass = "h-8 font-mono text-xs";

export function GrantMemberForm({
  serviceAccounts,
  memberships,
  pending,
  onGrant,
}: GrantMemberFormProps) {
  const ids = {
    provider: useId(),
    login: useId(),
    userId: useId(),
    service: useId(),
    issuer: useId(),
    subject: useId(),
    role: useId(),
    name: useId(),
  };
  const [provider, setProvider] = useState<Provider>("github");
  const [login, setLogin] = useState("");
  const [userId, setUserId] = useState("");
  const [manualId, setManualId] = useState(false);
  const [service, setService] = useState("");
  const [issuer, setIssuer] = useState("");
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<ProjectRole>("participant");
  const [displayName, setDisplayName] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const memberIds = new Set(
    memberships.filter((m) => m.revoked_at === null).map((m) => m.principal_id),
  );
  const availableServices = serviceAccounts.filter(
    (a) => a.revoked_at === null && !memberIds.has(a.principal_id),
  );

  async function resolveLogin(): Promise<number | null> {
    if (manualId) {
      const parsed = Number.parseInt(userId, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError("Enter the numeric GitHub user id.");
        return null;
      }
      return parsed;
    }
    if (!login.trim()) {
      setError("Enter a GitHub login.");
      return null;
    }
    setLookingUp(true);
    try {
      const user = await githubUserLookup(login.trim());
      setUserId(String(user.id));
      return user.id;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "github-lookup-failed";
      setError(err instanceof ApiError ? err.message : "GitHub lookup failed");
      if (code !== "github-user-not-found") setManualId(true);
      return null;
    } finally {
      setLookingUp(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    let body: MembershipGrantRequest;
    if (provider === "github") {
      const id = await resolveLogin();
      if (id === null) return;
      body = {
        principal: {
          provider: "github",
          host: "github.com",
          user_id: id,
          ...(login.trim() ? { login: login.trim() } : {}),
        },
        subject_kind: "human",
        role,
        ...(displayName.trim() || login.trim()
          ? { display_name: displayName.trim() || login.trim() }
          : {}),
      };
    } else if (provider === "service") {
      if (!service) {
        setError("Choose a service account.");
        return;
      }
      const account = serviceAccounts.find((a) => a.principal_id === service);
      body = {
        principal: {
          provider: "service",
          id: service.replace(/^service:/, ""),
        },
        subject_kind: "service",
        role,
        ...(displayName.trim() || account?.display_name
          ? { display_name: displayName.trim() || account?.display_name }
          : {}),
      };
    } else {
      if (!issuer.trim() || !subject.trim()) {
        setError("Enter the OIDC issuer URL and subject.");
        return;
      }
      body = {
        principal: {
          provider: "oidc",
          issuer: issuer.trim(),
          subject: subject.trim(),
        },
        subject_kind: "human",
        role,
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
      };
    }
    try {
      const result = await onGrant(body);
      if (result.created) {
        setNotice(
          `Granted ${result.membership.role} to ${displayName.trim() || login.trim() || result.membership.principal_id}.`,
        );
        setLogin("");
        setUserId("");
        setManualId(false);
        setService("");
        setIssuer("");
        setSubject("");
        setDisplayName("");
      } else {
        setNotice("Already a member; existing role kept.");
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "step-up-required") return;
      setError(err instanceof Error ? err.message : "Grant failed");
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Grant membership"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h3 className="tila-label">Grant membership</h3>
      <fieldset className="flex flex-wrap gap-3" aria-labelledby={ids.provider}>
        <legend id={ids.provider} className="sr-only">
          Principal type
        </legend>
        {(
          [
            ["github", "GitHub user"],
            ["service", "Service account"],
            ["oidc", "OIDC subject"],
          ] as const
        ).map(([value, label]) => (
          <label
            key={value}
            className="flex cursor-pointer items-center gap-1.5 text-sm"
          >
            <input
              type="radio"
              name="provider"
              value={value}
              checked={provider === value}
              onChange={() => {
                setProvider(value);
                setError(null);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <div className="grid gap-3 md:grid-cols-3">
        {provider === "github" && (
          <>
            <div className="space-y-1">
              <label htmlFor={ids.login} className="tila-label block">
                GitHub login
              </label>
              <Input
                id={ids.login}
                className={inputClass}
                value={login}
                placeholder="octocat"
                autoComplete="off"
                onChange={(e) => setLogin(e.target.value)}
              />
            </div>
            {manualId ? (
              <div className="space-y-1">
                <label htmlFor={ids.userId} className="tila-label block">
                  GitHub user id
                </label>
                <Input
                  id={ids.userId}
                  className={inputClass}
                  value={userId}
                  inputMode="numeric"
                  placeholder="583231"
                  onChange={(e) => setUserId(e.target.value)}
                />
              </div>
            ) : (
              <div className="flex items-end">
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                  onClick={() => setManualId(true)}
                >
                  Enter user id manually
                </button>
              </div>
            )}
          </>
        )}
        {provider === "service" && (
          <div className="space-y-1 md:col-span-2">
            <label htmlFor={ids.service} className="tila-label block">
              Service account
            </label>
            <select
              id={ids.service}
              value={service}
              onChange={(e) => setService(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground"
            >
              <option value="">
                {availableServices.length === 0
                  ? "No service accounts without membership"
                  : "Choose…"}
              </option>
              {availableServices.map((a) => (
                <option key={a.principal_id} value={a.principal_id}>
                  {a.display_name || a.name} ({a.principal_id})
                </option>
              ))}
            </select>
          </div>
        )}
        {provider === "oidc" && (
          <>
            <div className="space-y-1">
              <label htmlFor={ids.issuer} className="tila-label block">
                Issuer URL
              </label>
              <Input
                id={ids.issuer}
                className={inputClass}
                value={issuer}
                placeholder="https://issuer.example"
                onChange={(e) => setIssuer(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.subject} className="tila-label block">
                Subject
              </label>
              <Input
                id={ids.subject}
                className={inputClass}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
          </>
        )}
        <div className="space-y-1">
          <label htmlFor={ids.role} className="tila-label block">
            Role
          </label>
          <select
            id={ids.role}
            value={role}
            onChange={(e) => setRole(e.target.value as ProjectRole)}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground"
          >
            {PROJECT_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.name} className="tila-label block">
            Display name (optional)
          </label>
          <Input
            id={ids.name}
            className={inputClass}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-status-red">
          {error}
        </p>
      )}
      {notice && (
        <output className="block text-sm text-status-green">{notice}</output>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || lookingUp}>
          {lookingUp ? "Looking up…" : pending ? "Granting…" : "Grant"}
        </Button>
        {provider === "github" && !manualId && (
          <span className="text-xs text-muted-foreground">
            The login is resolved to a user id via GitHub's public API; no
            GitHub App is required.
          </span>
        )}
      </div>
    </form>
  );
}
