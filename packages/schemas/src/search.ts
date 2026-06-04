import { z } from "zod";

export const NormalizedArtifactTextSchema = z.object({
  title: z.string().nullable(),
  body_text: z.string(),
});

export type NormalizedArtifactText = z.infer<
  typeof NormalizedArtifactTextSchema
>;
