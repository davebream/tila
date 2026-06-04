const DEFAULT_GITHUB_HEADERS: Record<string, string> = {
  "User-Agent": "tila-worker/0.1.0",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

/**
 * Fetch wrapper for GitHub API calls.
 * Merges standard GitHub API headers with any caller-provided headers.
 * Caller-provided headers override defaults.
 */
export function githubFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const callerHeaders =
    init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : ((init?.headers as Record<string, string> | undefined) ?? {});

  const mergedHeaders = {
    ...DEFAULT_GITHUB_HEADERS,
    ...callerHeaders,
  };

  return fetch(url, {
    ...init,
    headers: mergedHeaders,
  });
}
