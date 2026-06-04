import { describe, expect, it } from "vitest";
import { buildManifest } from "../../lib/github-app-manifest";

describe("buildManifest", () => {
  const callbackUrl = "http://localhost:12345";

  it("returns manifest with correct permissions", () => {
    const manifest = buildManifest(callbackUrl);

    expect(manifest.default_permissions).toEqual({
      metadata: "read",
      members: "read",
    });
  });

  it("sets callback_urls to placeholder when no workerUrl provided", () => {
    const manifest = buildManifest(callbackUrl);

    expect(manifest.callback_urls).toEqual(["https://example.com/placeholder"]);
  });

  it("sets callback_urls to OAuth callback path when workerUrl is provided", () => {
    const workerUrl = "https://my-worker.workers.dev";
    const manifest = buildManifest(callbackUrl, workerUrl);

    expect(manifest.callback_urls).toEqual([
      `${workerUrl}/api/auth/github/oauth/callback`,
    ]);
  });

  it("sets redirect_url to the provided callbackUrl", () => {
    const manifest = buildManifest(callbackUrl);

    expect(manifest.redirect_url).toBe(callbackUrl);
  });

  it("sets public to false", () => {
    const manifest = buildManifest(callbackUrl);

    expect(manifest.public).toBe(false);
  });

  it("sets request_oauth_on_install to false", () => {
    const manifest = buildManifest(callbackUrl);

    expect(manifest.request_oauth_on_install).toBe(false);
  });

  it("defaults name to 'tila' when no projectId provided", () => {
    const manifest = buildManifest(callbackUrl);

    expect(manifest.name).toBe("tila");
  });

  it("appends sanitized projectId to name when provided", () => {
    const manifest = buildManifest(callbackUrl, undefined, "my-project-123");

    expect(manifest.name).toBe("tila-my-project-123");
  });

  it("sanitizes projectId to alphanumeric and hyphens only", () => {
    const manifest = buildManifest(callbackUrl, undefined, "my_project@test!");

    // Underscores, @ symbols, and ! should be removed/replaced
    expect(manifest.name).toMatch(/^tila-[a-z0-9-]+$/);
  });

  it("caps name length at 34 characters", () => {
    const longProjectId = "a".repeat(50);
    const manifest = buildManifest(callbackUrl, undefined, longProjectId);

    expect(typeof manifest.name).toBe("string");
    expect((manifest.name as string).length).toBeLessThanOrEqual(34);
  });

  it("sets url to github.com/apps placeholder", () => {
    const manifest = buildManifest(callbackUrl);

    expect(manifest.url).toBe("https://github.com/apps");
  });

  it("sets default_events to empty array", () => {
    const manifest = buildManifest(callbackUrl);

    expect(manifest.default_events).toEqual([]);
  });
});
