import { z } from "zod";
import { ErrorEnvelopeSchema } from "./api";
import { JournalEventSchema } from "./journal";

export const CUSTOM_REPORT_DATA_BYTES = 16 * 1024;
export const CUSTOM_REPORT_BODY_BYTES = 64 * 1024;
export const CUSTOM_REPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CUSTOM_REPORT_PRINCIPAL_RATE = 60;
export const CUSTOM_REPORT_PROJECT_RATE = 300;
export const JournalIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);
export const CustomEventNameSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
export const JournalCorrelationIdSchema = JournalIdempotencyKeySchema;

/** Iterative validation bounds both JSON depth and work before serialization. */
const ReportDataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((data, ctx) => {
    const pending: { value: unknown; depth: number }[] = [
      { value: data, depth: 1 },
    ];
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop();
      if (!item) break;
      const { value, depth } = item;
      if (++nodes > CUSTOM_REPORT_DATA_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: "Report data exceeds the JSON size limit",
          params: { code: "payload-too-large" },
        });
        return;
      }
      if (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        continue;
      if (
        typeof value !== "object" ||
        depth > 16 ||
        (!Array.isArray(value) &&
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Report data must be JSON with at most 16 container levels",
        });
        return;
      }
      for (const child of Object.values(value))
        pending.push({ value: child, depth: depth + 1 });
    }
    if (
      new TextEncoder().encode(JSON.stringify(data)).byteLength >
      CUSTOM_REPORT_DATA_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message: "Report data exceeds 16 KiB",
        params: { code: "payload-too-large" },
      });
  });

export const JournalReportTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z
    .object({
      kind: z.literal("resource"),
      resource: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("claim"),
      resource: z.string().min(1).max(1024),
      fence: z.number().int().positive().safe(),
    })
    .strict(),
]);
export const JournalAppendRequestSchema = z
  .object({
    event_name: CustomEventNameSchema,
    event_version: z.number().int().min(1).max(2_147_483_647),
    target: JournalReportTargetSchema,
    data: ReportDataSchema,
    correlation_id: JournalCorrelationIdSchema.optional(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    corrects_seq: z.number().int().positive().safe().optional(),
    artifact_refs: z.array(z.string().min(1).max(1024)).max(10).optional(),
  })
  .strict();
export type JournalAppendRequest = z.infer<typeof JournalAppendRequestSchema>;
export const JournalReportedEventSchema = JournalEventSchema.extend({
  seq: z.number().int().positive().safe(),
  t: z.number().int().nonnegative().safe(),
  kind: z.literal("custom.reported"),
  data: JournalAppendRequestSchema,
});
export const JournalAppendResponseSchema = z
  .object({
    ok: z.literal(true),
    event: JournalReportedEventSchema.strict(),
    dedup_expires_at: z.number().int().positive().safe(),
  })
  .strict();
export type JournalAppendResponse = z.infer<typeof JournalAppendResponseSchema>;
export const JournalAppendErrorResponseSchema = ErrorEnvelopeSchema.extend({
  error: ErrorEnvelopeSchema.shape.error.strict(),
}).strict();
export type JournalAppendErrorResponse = z.infer<
  typeof JournalAppendErrorResponseSchema
>;

export const JournalAppendErrorCodeSchema = z.enum([
  "validation-error",
  "payload-too-large",
  "permission-denied",
  "participant-required",
  "not-found",
  "stale-fence",
  "no-fence",
  "idempotency-key-conflict",
  "rate-limited",
  "journal-history-unavailable",
  "unsupported-capability",
]);
export function journalValidationCode(
  error: z.ZodError,
): "payload-too-large" | "validation-error" {
  return error.issues.some(
    (issue) =>
      issue.code === "custom" && issue.params?.code === "payload-too-large",
  )
    ? "payload-too-large"
    : "validation-error";
}
