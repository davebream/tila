import { z } from "zod";
import {
  ArtifactLineageIdSchema,
  ArtifactRevisionSchema,
  artifactVersionPrefix,
} from "./artifact-version";

export const ArtifactDeleteOptionsSchema = z.object({
  fence: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).optional(),
});
export type ArtifactDeleteOptions = z.infer<typeof ArtifactDeleteOptionsSchema>;
export const ArtifactDestroyRequestSchema = z.object({
  fence: z.number().int().positive(),
});
export const ArtifactDestroyResponseSchema = z.object({
  ok: z.literal(true),
  lineage_id: ArtifactLineageIdSchema,
  destroyed_at: z.number().int(),
});
export type ArtifactDestroyResponse = z.infer<
  typeof ArtifactDestroyResponseSchema
>;
export const ArtifactLifecycleRecordSchema = z
  .object({
    format: z.literal("tila-artifact-lifecycle-v1"),
    type: z.enum(["retention", "tombstone", "deleted", "destroy"]),
    project_id: z.string().min(1),
    lineage_id: ArtifactLineageIdSchema,
    kind: z.string(),
    resource: z.string().nullable(),
    at: z.number().int(),
    pointer: ArtifactRevisionSchema.omit({ review: true }).optional(),
  })
  .superRefine((record, ctx) => {
    if (
      record.type !== "destroy" &&
      (!record.pointer || record.pointer.lineage_id !== record.lineage_id)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Revision lifecycle record requires a matching pointer",
      });
  });
export type ArtifactLifecycleRecord = z.infer<
  typeof ArtifactLifecycleRecordSchema
>;
export function artifactLifecycleKey(record: ArtifactLifecycleRecord): string {
  if (record.type === "destroy")
    return `${artifactVersionPrefix(record.project_id)}${record.lineage_id}/destroy.json`;
  if (!record.pointer) throw new Error("Missing lifecycle pointer");
  return `${record.pointer.r2_key}.${record.type}.json`;
}
