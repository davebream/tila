import { z } from "zod";
import { EnvironmentMetadataSchema, ParticipantIdSchema } from "./identity";

export const ClaimModeSchema = z.enum(["exclusive", "owner", "presence"]);

export type ClaimMode = z.infer<typeof ClaimModeSchema>;

export const ClaimSchema = z.object({
  resource: z.string(),
  principal_id: z.string(),
  participant_id: ParticipantIdSchema,
  environment: EnvironmentMetadataSchema,
  mode: ClaimModeSchema,
  fence: z.number().int(),
  acquired_at: z.number().int(),
  expires_at: z.number().int(),
  metadata: z.record(z.unknown()).optional(),
});

export type Claim = z.infer<typeof ClaimSchema>;
