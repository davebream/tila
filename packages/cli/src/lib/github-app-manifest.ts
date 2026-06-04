/**
 * Build a GitHub App Manifest for automated App creation.
 *
 * @param callbackUrl - The local callback URL (e.g., "http://localhost:12345") where
 *   GitHub will redirect after App creation
 * @param workerUrl - Optional Worker URL (e.g., "https://my-worker.workers.dev") used to
 *   set the real OAuth callback_urls for the GitHub App
 * @param projectId - Optional project ID to include in the App name
 * @returns A GitHub App Manifest object ready for submission to GitHub
 */
export function buildManifest(
  callbackUrl: string,
  workerUrl?: string,
  projectId?: string,
): Record<string, unknown> {
  // Sanitize projectId: keep only alphanumeric and hyphens, lowercase
  const sanitizedSuffix = projectId
    ? projectId
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
    : "";

  // Build the name: "tila" or "tila-<suffix>"
  const baseName = sanitizedSuffix ? `tila-${sanitizedSuffix}` : "tila";

  // Cap at 34 characters per GitHub's App name length limit
  const name = baseName.slice(0, 34);

  const manifest: Record<string, unknown> = {
    name,
    url: "https://github.com/apps",
    redirect_url: callbackUrl,
    callback_urls: workerUrl
      ? [`${workerUrl}/api/auth/github/oauth/callback`]
      : ["https://example.com/placeholder"],
    default_permissions: {
      metadata: "read",
      members: "read",
    },
    default_events: [],
    public: false,
    request_oauth_on_install: false,
  };

  return manifest;
}
