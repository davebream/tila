import { z } from "zod";

/** Public, secret-free projection of a verified CLI deployment target. */
export const DeployTargetSchema = z.object({
  source: z.enum([
    "infra-flag",
    "flag",
    "env",
    "repo-pointer",
    "current-context",
  ]),
  infraSlug: z.string(),
  instanceKey: z.string().nullable(),
  workerUrl: z.string().url().nullable(),
  accountId: z.string(),
  accountName: z.string(),
  scriptName: z.string(),
  d1DatabaseId: z.string(),
  r2BucketName: z.string(),
});

export type DeployTarget = z.infer<typeof DeployTargetSchema>;
