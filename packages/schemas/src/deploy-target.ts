import { z } from "zod";

/** Non-secret settings carried from control-plane inspection to deployment. */
export const DeploymentSettingsSchema = z
  .object({
    workersDev: z.boolean(),
    // Omitted only for a confirmed new Worker, retaining Wrangler's initial default.
    previewUrls: z.boolean().optional(),
    analyticsEngineDatasets: z
      .array(
        z.object({
          binding: z
            .string()
            .min(1)
            .refine((value) => value === value.trim()),
          dataset: z
            .string()
            .min(1)
            .refine((value) => value === value.trim()),
        }),
      )
      .min(1),
  })
  .refine((settings) => {
    const names = settings.analyticsEngineDatasets.map(
      (entry) => entry.binding,
    );
    return names.includes("ANALYTICS") && new Set(names).size === names.length;
  }, "Analytics bindings must be unique and include ANALYTICS");

export type DeploymentSettings = z.infer<typeof DeploymentSettingsSchema>;

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
  workerUrl: z.string().url(),
  accountId: z.string(),
  accountName: z.string(),
  scriptName: z.string(),
  d1DatabaseId: z.string(),
  r2BucketName: z.string(),
  settings: DeploymentSettingsSchema,
});

export type DeployTarget = z.infer<typeof DeployTargetSchema>;
