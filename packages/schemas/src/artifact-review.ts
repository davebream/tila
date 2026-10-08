import { z } from "zod";
import { EnvironmentMetadataSchema } from "./identity";

/** Principal is authenticated remotely; participant/environment are client-supplied. */
export const ArtifactProvenanceSchema = z.object({
  principal_id: z.string().min(1),
  participant_id: z.string().min(1),
  created_at: z.number().int(),
  client_name: z.string().nullable(),
  client_version: z.string().nullable(),
  environment: EnvironmentMetadataSchema,
});
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

export const ArtifactReviewDecisionSchema = z.enum([
  "trusted",
  "rejected",
  "superseded",
  "revoked",
]);
export const ArtifactReviewStateSchema = z.enum([
  "unreviewed",
  "trusted",
  "rejected",
  "superseded",
]);
export const ArtifactReviewEventSchema = z.object({
  artifact_key: z.string(),
  review_revision: z.number().int().positive(),
  principal_id: z.string(),
  participant_id: z.string(),
  created_at: z.number().int(),
  decision: ArtifactReviewDecisionSchema,
  reason: z.string().max(4096).nullable(),
});
export type ArtifactReviewEvent = z.infer<typeof ArtifactReviewEventSchema>;
export const ArtifactReviewSummarySchema = z.object({
  state: ArtifactReviewStateSchema,
  review_revision: z.number().int().nonnegative(),
  latest: ArtifactReviewEventSchema.nullable(),
});
export type ArtifactReviewSummary = z.infer<typeof ArtifactReviewSummarySchema>;
export const ArtifactReviewRequestSchema = z
  .object({
    expected_review_revision: z.number().int().nonnegative(),
    decision: ArtifactReviewDecisionSchema,
    reason: z.string().max(4096).optional(),
  })
  .strict();
export type ArtifactReviewRequest = z.infer<typeof ArtifactReviewRequestSchema>;
export const ArtifactReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before_revision: z.coerce.number().int().positive().optional(),
});
export type ArtifactReviewsQuery = z.input<typeof ArtifactReviewsQuerySchema>;
export const ArtifactReviewsResponseSchema = z.object({
  ok: z.literal(true),
  items: z.array(ArtifactReviewEventSchema),
  next_revision: z.number().int().positive().nullable(),
});
export type ArtifactReviewsResponse = z.infer<
  typeof ArtifactReviewsResponseSchema
>;
export const ArtifactReviewResponseSchema = z.object({
  ok: z.literal(true),
  review: ArtifactReviewSummarySchema,
});
export type ArtifactReviewResponse = z.infer<
  typeof ArtifactReviewResponseSchema
>;

/** Optional on the wire for compatibility; current producers always populate these. */
export const ArtifactTrustFieldsSchema = z.object({
  provenance: ArtifactProvenanceSchema.nullable().optional(),
  revision_creation: ArtifactProvenanceSchema.nullable().optional(),
  review: ArtifactReviewSummarySchema.optional(),
});
