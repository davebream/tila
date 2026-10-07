import { z } from "zod";
import { ArtifactPointerSchema } from "./artifact";
import { EnvironmentMetadataSchema } from "./identity";
import { TagsSchema } from "./tags";

export const ArtifactLineageIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const ArtifactVersionFieldsSchema = z.object({
  lineage_id: ArtifactLineageIdSchema.optional(),
  lineage_fence: z.number().int().positive().optional(),
});
export const ArtifactRevisionSchema = ArtifactPointerSchema.extend({
  lineage_id: ArtifactLineageIdSchema.nullable(),
  revision: z.number().int().positive().nullable(),
  restored_from: z.string().nullable(),
  tombstoned_at: z.number().int().nullable().optional(),
  blob_deleted_at: z.number().int().nullable().optional(),
});
export type ArtifactRevision = z.infer<typeof ArtifactRevisionSchema>;
export const ArtifactHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().finite().optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export type ArtifactHistoryQuery = z.infer<typeof ArtifactHistoryQuerySchema>;
export const ArtifactHistoryResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(ArtifactRevisionSchema),
  meta: z.object({
    total: z.number().int(),
    limit: z.number().int(),
    next_cursor: z.string().nullable(),
  }),
});
export type ArtifactHistoryResponse = z.infer<
  typeof ArtifactHistoryResponseSchema
>;
export const ArtifactMetaResponseSchema = z.object({
  ok: z.literal(true),
  pointer: ArtifactRevisionSchema,
});
export type ArtifactMetaResponse = z.infer<typeof ArtifactMetaResponseSchema>;
export const ArtifactRestoreRequestSchema = z.object({
  fence: z.number().int().positive(),
  lineage_id: ArtifactLineageIdSchema.optional(),
  tags: TagsSchema.optional(),
});
export type ArtifactRestoreRequest = z.infer<
  typeof ArtifactRestoreRequestSchema
>;
export const ArtifactRevisionResponseSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
  bytes: z.number().int(),
  deduplicated: z.boolean(),
  pointer: ArtifactRevisionSchema,
  restored_from: z.string().nullable(),
});
export type ArtifactRevisionResponse = z.infer<
  typeof ArtifactRevisionResponseSchema
>;

// Recovery records are trusted only when read from the project's private blob
// store. No public route accepts a caller-supplied record for import.
export const ArtifactCommitRecordSchema = z.object({
  format: z.literal("tila-artifact-revision-v1"),
  retention_assigned: z.literal(true).optional(),
  project_id: z.string().min(1),
  operation_id: z.string().min(1),
  request_hash: z.string(),
  deduplicated: z.boolean().optional(),
  pointer: ArtifactRevisionSchema.extend({
    lineage_id: ArtifactLineageIdSchema,
    revision: z.number().int().positive(),
  }),
  lineage_fence: z.number().int().positive(),
  origin: z.object({
    principalId: z.string(),
    participantId: z.string(),
    actor: z.string(),
    environment: EnvironmentMetadataSchema,
    tokenId: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    sourceVersion: z.string().nullable().optional(),
    machine: z.string().nullable().optional(),
  }),
});
export type ArtifactCommitRecord = z.infer<typeof ArtifactCommitRecordSchema>;

export function artifactVersionPrefix(projectId: string): string {
  return `versioned/${encodeURIComponent(projectId)}/`;
}
export function artifactRevisionKey(
  projectId: string,
  lineage: string,
  revision: number,
  sha256: string,
  mime: string,
): string {
  const ext =
    mime === "text/markdown"
      ? "md"
      : mime === "text/plain"
        ? "txt"
        : mime === "application/json"
          ? "json"
          : "bin";
  return `${artifactVersionPrefix(projectId)}${ArtifactLineageIdSchema.parse(lineage)}/${revision}/${sha256}.${ext}`;
}
export function artifactCommitKey(pointer: { r2_key: string }): string {
  return `${pointer.r2_key}.commit.json`;
}
