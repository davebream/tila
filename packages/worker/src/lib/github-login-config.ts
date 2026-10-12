import type { Env } from "../types";

/** Browser OAuth is an instance opt-in, independent of CLI and repository auth. */
export function getGitHubLoginConfig(env: Env) {
  if (env.GITHUB_LOGIN_ENABLED !== "true") {
    return { status: "disabled" } as const;
  }

  const clientId = env.GITHUB_APP_CLIENT_ID;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
  const hmacKey = env.GITHUB_SESSION_HMAC_KEY;
  if (!clientId?.trim() || !clientSecret?.trim() || !hmacKey?.trim()) {
    return { status: "not-configured" } as const;
  }

  return { status: "enabled", clientId, clientSecret, hmacKey } as const;
}

export function githubLoginUnavailableResponse(
  status: "disabled" | "not-configured",
): Response {
  const disabled = status === "disabled";
  return Response.json(
    {
      ok: false,
      error: {
        code: disabled ? "github-login-disabled" : "not-configured",
        message: disabled
          ? "GitHub browser login is disabled on this instance"
          : "GitHub browser login is not configured on this instance",
        retryable: false,
      },
    },
    {
      status: disabled ? 404 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
