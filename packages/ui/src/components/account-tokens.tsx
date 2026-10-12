import { accountRequest } from "@/lib/account-api";
import {
  CAPABILITIES,
  type ProjectRole,
  delegablePolicy,
  effectiveCredentialPolicy,
} from "@tila/schemas";
import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface PersonalToken {
  name: string;
  token_id: string;
  status: string;
  expires_at: number | null;
  policy: { role: string };
}
export function AccountTokens() {
  const [projects, setProjects] = useState<
    { projectId: string; role?: ProjectRole }[]
  >([]);
  const [projectId, setProjectId] = useState("");
  const [tokens, setTokens] = useState<PersonalToken[]>([]);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"viewer" | "participant">("viewer");
  const [days, setDays] = useState(30);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    import("@/lib/api")
      .then(({ workspaceProjects }) => workspaceProjects())
      .then((data) => {
        setProjects(data.projects);
        setProjectId(data.projects[0]?.projectId ?? "");
      })
      .catch((error) => setError(error.message));
  }, []);
  const refresh = useCallback(async () => {
    if (projectId)
      setTokens(
        (
          await accountRequest<{ tokens: PersonalToken[] }>(
            `/tokens?projectId=${encodeURIComponent(projectId)}`,
          )
        ).tokens,
      );
  }, [projectId]);
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, [refresh]);
  async function run(action: () => Promise<void>) {
    setError("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Token operation failed",
      );
    }
  }
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Your API tokens</h2>
      <p className="text-sm text-muted-foreground">
        For scripts and API clients. Tokens use your current project membership
        and cannot sign in to the dashboard.
      </p>
      {error && <p role="alert">{error}</p>}
      <label>
        Project
        <select
          className="ml-3 rounded border bg-background p-2"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.projectId}>{project.projectId}</option>
          ))}
        </select>
      </label>
      {projectId && (
        <>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const policy = delegablePolicy(
                  effectiveCredentialPolicy(
                    { role: access, capabilities: [...CAPABILITIES] },
                    access,
                  ),
                );
                const result = await accountRequest<{ token: string }>(
                  "/tokens",
                  {
                    projectId,
                    name,
                    policy,
                    expiresAt: Math.floor(Date.now() / 1000) + days * 86400,
                  },
                );
                setSecret(result.token);
                setName("");
              });
            }}
          >
            <label htmlFor="account-tokens-field-1">
              Name
              <Input
                id="account-tokens-field-1"
                value={name}
                onChange={(event) => setName(event.target.value)}
                pattern="[a-zA-Z0-9._-]+"
                required
              />
            </label>
            <label>
              Access
              <select
                className="ml-3 rounded border bg-background p-2"
                value={access}
                onChange={(event) =>
                  setAccess(event.target.value as "viewer" | "participant")
                }
              >
                <option value="viewer">Read only</option>
                <option value="participant">Read and write</option>
              </select>
            </label>
            <label htmlFor="account-tokens-field-2">
              Expires in days
              <Input
                id="account-tokens-field-2"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                required
              />
            </label>
            <Button>Create API token</Button>
          </form>
          {secret && (
            <div className="space-y-2 rounded border p-3">
              <p>Copy this token now. It will not be shown again.</p>
              <Input aria-label="New API token" value={secret} readOnly />
              <Button
                variant="outline"
                onClick={() => navigator.clipboard.writeText(secret)}
              >
                Copy token
              </Button>
              <Button variant="ghost" onClick={() => setSecret("")}>
                Done
              </Button>
            </div>
          )}
          <ul className="space-y-2">
            {tokens.map((token) => (
              <li className="space-y-2 rounded border p-3" key={token.name}>
                <p>
                  {token.name} · {token.status} · {token.policy.role}
                </p>
                <p className="text-xs">
                  Expires{" "}
                  {token.expires_at
                    ? new Date(token.expires_at * 1000).toLocaleDateString()
                    : "never"}
                </p>
                {token.status === "active" && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        run(async () => {
                          const result = await accountRequest<{
                            token: string;
                          }>(
                            `/tokens/${encodeURIComponent(token.name)}?projectId=${encodeURIComponent(projectId)}`,
                            {
                              expected_token_id: token.token_id,
                              overlap_seconds: 300,
                            },
                          );
                          setSecret(result.token);
                        })
                      }
                    >
                      Rotate (5-minute overlap)
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        run(async () => {
                          await accountRequest(
                            `/tokens/${encodeURIComponent(token.name)}?projectId=${encodeURIComponent(projectId)}`,
                            undefined,
                            "DELETE",
                          );
                        })
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
