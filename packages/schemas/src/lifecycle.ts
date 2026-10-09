import { z } from "zod";
import { HandoffCreateRequestSchema } from "./continuity";
import { EnvironmentMetadataSchema, ParticipantIdSchema } from "./identity";

export const LifecycleClientSchema = z.enum(["claude-code", "codex", "cli"]);
export type LifecycleClient = z.infer<typeof LifecycleClientSchema>;
export const LifecycleEventSchema = z.object({
  session_id: z.string().min(1).max(512),
  cwd: z.string().min(1).max(4096),
  hook_event_name: z.enum([
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "Stop",
  ]),
  source: z.string().optional(),
  reason: z.string().optional(),
});
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;
export const ProcessIdentitySchema = z.object({
  pid: z.number().int().positive(),
  started: z.string(),
});
export const LifecycleStateSchema = z.object({
  version: z.literal(1),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  namespace: z.string(),
  client: LifecycleClientSchema,
  sessionId: z.string(),
  participantId: ParticipantIdSchema,
  runtime: z
    .object({
      socket: z.string(),
      capability: z.string(),
      runId: z.string().uuid(),
    })
    .optional(),
  cwd: z.string(),
  environment: EnvironmentMetadataSchema,
  generation: z.string().uuid(),
  owner: ProcessIdentitySchema.nullable(),
  worker: ProcessIdentitySchema.nullable(),
  phase: z.enum(["active", "closing", "closed", "crashed"]),
  observedSeq: z.number().int().nonnegative(),
  offeredSeq: z.number().int().nonnegative(),
  lastHeartbeat: z.number().nullable(),
  degraded: z.string().nullable(),
  reentryPending: z.boolean(),
  resumeHandoffId: z.string().uuid().nullable().optional(),
  pendingHandoff: HandoffCreateRequestSchema.nullable(),
  handoffSaved: z.boolean(),
  cursorSaved: z.boolean(),
  releaseClaims: z.array(
    z.object({ resource: z.string(), fence: z.number().int() }),
  ),
});
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
