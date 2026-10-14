import { z } from "zod";

export const GITHUB_ACTIONS_ISSUER =
  "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_HOST = "github.com";
export const GITHUB_ACTIONS_JWKS_URI =
  "https://token.actions.githubusercontent.com/.well-known/jwks";
export const AUTHORIZATION_VERSION = 2;

/** Endpoint identity is exact; credentials, query strings and fragments are forbidden. */
export const GitHubActionsEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#") &&
        value === value.trim()
      );
    } catch {
      return false;
    }
  });
export const GitHubActionsHostSchema = z
  .string()
  .max(253)
  .refine((host) =>
    host
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
  );

export const GitHubActionsTrustedIssuerSchema = z
  .object({
    issuer: GitHubActionsEndpointSchema,
    host: GitHubActionsHostSchema,
    jwks_uri: GitHubActionsEndpointSchema,
  })
  .strict();
export type GitHubActionsTrustedIssuer = z.infer<
  typeof GitHubActionsTrustedIssuerSchema
>;

/** Reject duplicate canonical identities and any attempt to replace GitHub.com. */
export const GitHubActionsTrustedIssuersSchema = z
  .array(GitHubActionsTrustedIssuerSchema)
  .superRefine((entries, ctx) => {
    const issuers = new Set([GITHUB_ACTIONS_ISSUER]);
    for (const entry of entries) {
      if (!GitHubActionsEndpointSchema.safeParse(entry.issuer).success)
        continue;
      const identity = new URL(entry.issuer).toString().replace(/\/$/, "");
      if (issuers.has(identity) || entry.host === GITHUB_ACTIONS_HOST) {
        ctx.addIssue({
          code: "custom",
          message: "Ambiguous Actions issuer mapping",
        });
      }
      issuers.add(identity);
    }
  });

/** Verified, non-secret claims needed to re-evaluate repository policy. */
export const GitHubActionsContextSchema = z
  .object({
    /** Absent only in legacy GitHub.com contexts. New exchanges always set both. */
    issuer: GitHubActionsEndpointSchema.optional(),
    repository_host: GitHubActionsHostSchema.optional(),
    repository_id: z.number().int().positive(),
    sub: z.string().min(1).max(255),
    event_name: z.string().min(1),
    ref: z.string().optional(),
    environment: z.string().optional(),
    job_workflow_ref: z.string().optional(),
  })
  .refine(
    (context) =>
      (context.issuer === undefined) ===
      (context.repository_host === undefined),
    "Actions issuer and repository host must be supplied together",
  );
export type GitHubActionsContext = z.infer<typeof GitHubActionsContextSchema>;

/** Legacy contexts can only denote the historical GitHub.com identity. */
export function githubActionsIdentity(context: GitHubActionsContext) {
  return {
    issuer: context.issuer ?? GITHUB_ACTIONS_ISSUER,
    host: context.repository_host ?? GITHUB_ACTIONS_HOST,
  };
}
