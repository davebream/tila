import { z } from "zod";

/**
 * GitHub username format: 1–39 chars, alphanumeric or single hyphens (not at
 * start/end). This is the single source of truth for login validation — used
 * by both the worker (admin-grant helper) and the CLI (login resolver).
 *
 * Validated BEFORE any outbound call to eliminate malformed-URL /
 * token-leak-via-bad-path risk in GET /users/{login}.
 */
export const GITHUB_LOGIN_REGEX = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** Public instance capability; never includes OAuth credentials. */
export const GitHubLoginConfigResponseSchema = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
});
export type GitHubLoginConfigResponse = z.infer<
  typeof GitHubLoginConfigResponseSchema
>;
