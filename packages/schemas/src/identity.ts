import { z } from "zod";

export const ParticipantIdSchema = z
  .string()
  .min(1, "participant ID is required")
  .max(255, "participant ID must be at most 255 characters");

export type ParticipantId = z.infer<typeof ParticipantIdSchema>;

const EnvironmentValueSchema = z.string().min(1).max(2048);

export const EnvironmentMetadataSchema = z
  .object({
    machine: EnvironmentValueSchema.optional(),
    repository: EnvironmentValueSchema.optional(),
    worktree: EnvironmentValueSchema.optional(),
    branch: EnvironmentValueSchema.optional(),
    commit: EnvironmentValueSchema.optional(),
    client_name: EnvironmentValueSchema.optional(),
    client_version: EnvironmentValueSchema.optional(),
  })
  .strict();

export type EnvironmentMetadata = z.infer<typeof EnvironmentMetadataSchema>;

export const IdentityContextSchema = z.object({
  principal_id: z.string().min(1).max(2048),
  participant_id: ParticipantIdSchema,
  environment: EnvironmentMetadataSchema.default({}),
});

export type IdentityContext = z.infer<typeof IdentityContextSchema>;
