import { z } from "zod";

export const WorkBlockReasonSchema = z.object({
  code: z.enum([
    "missing",
    "archived",
    "lifecycle-unconfigured",
    "not-dispatchable",
    "dependency-missing",
    "dependency-unsatisfied",
    "dependency-lifecycle-unconfigured",
    "dependency-cycle",
    "gate-pending",
  ]),
  resource: z.string(),
  state: z.string().optional(),
  path: z.array(z.string()).optional(),
});
export type WorkBlockReason = z.infer<typeof WorkBlockReasonSchema>;

export const WorkReadinessSchema = z.object({
  ready: z.boolean(),
  reasons: z.array(WorkBlockReasonSchema),
});
export type WorkReadiness = z.infer<typeof WorkReadinessSchema>;
