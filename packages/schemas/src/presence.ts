import { z } from "zod";
import { EnvironmentMetadataSchema, ParticipantIdSchema } from "./identity";

export const PresenceSchema = z.object({
  principal_id: z.string(),
  participant_id: ParticipantIdSchema,
  environment: EnvironmentMetadataSchema,
  last_seen: z.number().int(),
  info: z.record(z.unknown()),
});

export type Presence = z.infer<typeof PresenceSchema>;
