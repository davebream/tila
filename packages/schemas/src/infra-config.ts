import { z } from "zod";

export const TilaInfraConfigSchema = z.object({
  account_id: z.string(),
  account_name: z.string(),
  d1_database_id: z.string(),
  worker_url: z.string().url().optional(),
  r2_bucket_name: z.string().optional(),
  hmac_key: z.string().optional(),
  sweep_secret: z.string().optional(),
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
