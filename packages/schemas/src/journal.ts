import { z } from "zod";
import { EnvironmentMetadataSchema, ParticipantIdSchema } from "./identity";

export const JournalEventKindSchema = z.enum([
  "entity.created",
  "entity.updated",
  "entity.archived",
  "claim.acquired",
  "claim.renewed",
  "claim.released",
  "claim.expired",
  "artifact.produced",
  "artifact.expired",
  "artifact.tombstoned",
  "artifact.reconciled",
  "artifact.search.rebuilt",
  "schema.applied",
  "artifact.relationship.added",
  "entity.artifact.referenced",
  "gate.created",
  "gate.resolved",
  "gate.timed_out",
  "gate.cancelled",
  "template.instantiated",
  "record.created",
  "record.updated",
  "record.archived",
  "record.unarchived",
]);

export type JournalEventKind = z.infer<typeof JournalEventKindSchema>;

export const JournalEventSchema = z.object({
  seq: z.number().int(),
  t: z.number().int(),
  kind: JournalEventKindSchema,
  resource: z.string(),
  principal_id: z.string(),
  participant_id: ParticipantIdSchema,
  environment: EnvironmentMetadataSchema,
  token_id: z.string().nullable().optional(),
  fence: z.number().int().nullable(),
  data: z.record(z.unknown()),
});

export type JournalEvent = z.infer<typeof JournalEventSchema>;
