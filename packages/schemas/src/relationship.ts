import { z } from "zod";

export const EntityRelationshipTypeSchema = z.enum([
  "parent-child",
  "blocks",
  "soft-blocks",
  "related",
  "discovered-from",
]);

export type EntityRelationshipType = z.infer<
  typeof EntityRelationshipTypeSchema
>;

export const EntityRelationshipSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
  type: EntityRelationshipTypeSchema,
  schema_version: z.number().int(),
  created_at: z.number().int(),
});

export type EntityRelationship = z.infer<typeof EntityRelationshipSchema>;
