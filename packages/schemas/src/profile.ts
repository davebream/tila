import { z } from "zod";
import { AgentIdSchema } from "./agent";

export const CredentialProfileSchema = z
  .object({
    id: AgentIdSchema,
    revision: z.number().int().positive(),
    harness: z.enum(["claude-code", "codex"]),
    launcher: z.string().min(1).max(4096),
    config_dir: z.string().min(1).max(4096),
    credential_store: z.enum(["file", "keyring", "auto", "ephemeral"]),
    endpoint: z.string().url().optional(),
    env_allowlist: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(100)
      .default([]),
    account_ref: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const CredentialProfileFileSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(CredentialProfileSchema).max(100),
    revisions: z.record(AgentIdSchema, z.number().int().positive()).default({}),
  })
  .strict()
  .refine(
    (file) =>
      new Set(file.profiles.map((profile) => profile.id)).size ===
      file.profiles.length,
    {
      message: "Profile IDs must be unique",
    },
  );
export type CredentialProfile = z.infer<typeof CredentialProfileSchema>;
