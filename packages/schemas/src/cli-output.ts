import { z } from "zod";

/** The CLI contract is independent of HTTP responses and external hook protocols. */
export const CliPageMetaSchema = z
  .object({
    count: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    total: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    next_cursor: z.string().nullable().optional(),
    next_revision: z.number().int().positive().nullable().optional(),
    truncated: z.boolean().optional(),
    has_more_unknown: z.boolean().optional(),
  })
  .passthrough();

export const CliSuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  result: z
    .unknown()
    .refine((value) => value !== undefined, "result is required"),
  meta: CliPageMetaSchema.optional(),
});

export const CliErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    kind: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    hint: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type CliErrorEnvelope = z.infer<typeof CliErrorEnvelopeSchema>;
export type CliPageMeta = z.infer<typeof CliPageMetaSchema>;
export type CliSuccessEnvelope<T> = { ok: true; result: T; meta?: CliPageMeta };

export const CliDiagnosticSchema = z.object({
  type: z.literal("diagnostic"),
  level: z.enum(["info", "warning"]),
  message: z.string(),
});
export type CliDiagnostic = z.infer<typeof CliDiagnosticSchema>;
