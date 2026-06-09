import { z } from "zod";

export const EntitySchema = z.object({
  id: z.string(),
  type: z.string(),
  schema_version: z.number().int(),
  data: z.record(z.unknown()),
  archived: z.number().int().default(0),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  created_by: z.string(),
  tags: z.array(z.string()).default([]),
});

export type Entity = z.infer<typeof EntitySchema>;
