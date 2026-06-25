import { z } from "zod";

// --- PerSlugInfraMeta ---
// Non-secret per-deployment metadata stored in infra/<slug>.toml.
// These values are safe to store on disk.
export const PerSlugInfraMetaSchema = z.object({
  account_id: z.string(),
  account_name: z.string(),
  d1_database_id: z.string(),
  worker_url: z.string().url().optional(),
  pages_project_name: z.string().optional(),
  github_app: z
    .object({
      app_id: z.number().int().positive(),
      installation_id: z.number().int().positive(),
    })
    .optional(),
  infra_slug: z.string().optional(),
});

export type PerSlugInfraMeta = z.infer<typeof PerSlugInfraMetaSchema>;

// --- InfraSecrets ---
// Secret per-deployment credentials stored ONLY in the OS keychain.
// Never written to disk.
export const InfraSecretsSchema = z.object({
  hmac_key: z.string().optional(),
  sweep_secret: z.string().optional(),
  infra_admin_token: z.string().optional(),
});

export type InfraSecrets = z.infer<typeof InfraSecretsSchema>;

export const TilaInfraConfigSchema = z.object({
  account_id: z.string(),
  account_name: z.string(),
  d1_database_id: z.string(),
  worker_url: z.string().url().optional(),
  r2_bucket_name: z.string().optional(),
  hmac_key: z.string().optional(),
  sweep_secret: z.string().optional(),
  // Infra-owner secret for destroying any project by slug via the Worker's
  // /_internal/admin destroy endpoint (no per-project token). Mirrors sweep_secret.
  infra_admin_token: z.string().optional(),
  github_app: z
    .object({
      app_id: z.number().int().positive(),
      installation_id: z.number().int().positive(),
    })
    .optional(),
  pages_project_name: z.string().optional(),
  infra_slug: z.string().optional(),
});

export type TilaInfraConfig = z.infer<typeof TilaInfraConfigSchema>;
