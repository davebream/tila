import { z } from "zod";

export const PresenceSchema = z.object({
  machine: z.string(),
  last_seen: z.number().int(),
  info: z.record(z.unknown()),
});

export type Presence = z.infer<typeof PresenceSchema>;
