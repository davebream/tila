import { z } from "zod";

export const GITHUB_ACTIONS_ISSUER =
  "https://token.actions.githubusercontent.com";
export const AUTHORIZATION_VERSION = 2;

/** Verified, non-secret claims needed to re-evaluate repository policy. */
export const GitHubActionsContextSchema = z.object({
  repository_id: z.number().int().positive(),
  sub: z.string().min(1).max(255),
  event_name: z.string().min(1),
  ref: z.string().optional(),
  environment: z.string().optional(),
  job_workflow_ref: z.string().optional(),
});
export type GitHubActionsContext = z.infer<typeof GitHubActionsContextSchema>;
