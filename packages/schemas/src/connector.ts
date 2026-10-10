import { z } from "zod";
import { AgentIdSchema } from "./agent";
import { ProcessIdentitySchema } from "./lifecycle";

export const RegistrationSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().uuid(),
  owner: ProcessIdentitySchema,
  agent: z.string().min(1),
  profile: z.object({ id: z.string(), revision: z.number().int().positive() }),
  namespace: z.string(),
  actingRunId: z.string().uuid(),
  expectedEpoch: z.number().int().nonnegative(),
  allowIdleStart: z.boolean(),
  relayOperationId: z.string().uuid(),
  relayRunId: z.string().uuid().optional(),
  bindingId: z.string().uuid().optional(),
  bindingEpoch: z.number().int().positive().optional(),
  pending: z
    .object({
      leaseToken: z.string().uuid(),
      leaseUntil: z.number(),
      publishGen: z.number().int(),
      bindingId: z.string().uuid(),
      bindingEpoch: z.number().int(),
      // Written before calling the harness. A crash here is an uncertain wake.
      startedAt: z.number(),
      outcome: z
        .enum(["accepted", "rejected", "deferred", "unknown"])
        .optional(),
      reported: z.boolean().default(false),
    })
    .optional(),
  state: z.enum(["registering", "active", "closing", "unsupported", "paused"]),
  reason: z.string().max(200).optional(),
});
export type Registration = z.infer<typeof RegistrationSchema>;
export const LedgerSchema = z.object({
  version: z.literal(1),
  hostRef: z.string().uuid(),
  heartbeat: z.number(),
  registrations: z.array(RegistrationSchema).max(32),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export const ControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z
    .object({
      action: z.literal("register"),
      key: z.string().regex(/^[a-f0-9]{64}$/),
      expectedEpoch: z.number().int().nonnegative(),
      allowIdleStart: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("unregister"),
      key: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

export const LaunchRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    agent: AgentIdSchema,
    profile: AgentIdSchema,
    profileRevision: z.number().int().positive(),
    namespace: z.string(),
    sessionId: z.string().uuid(),
  })
  .strict();
export type LaunchRequest = z.infer<typeof LaunchRequestSchema>;
export const LaunchIntentSchema = z.object({
  request: LaunchRequestSchema,
  createdAt: z.number(),
  state: z.enum(["launching", "running", "exited", "uncertain"]),
  process: ProcessIdentitySchema.nullable(),
  discoveredKey: z.string().optional(),
  exitCode: z.number().nullable().optional(),
});
export type LaunchIntent = z.infer<typeof LaunchIntentSchema>;

export const HerdrPaneSchema = z.object({
  pane_id: z.string(),
  terminal_id: z.string(),
  agent: z.string().optional(),
  agent_status: z.string(),
  agent_session: z
    .object({
      source: z.string(),
      agent: z.string(),
      kind: z.enum(["id", "path"]),
      value: z.string(),
    })
    .optional(),
  revision: z.number().int().nonnegative(),
});
export const HerdrSnapshotSchema = z.object({
  version: z.string(),
  protocol: z.number().int(),
  panes: z.array(HerdrPaneSchema).max(4096),
});
export const HerdrProcessInfoSchema = z.object({
  pane_id: z.string(),
  shell_pid: z.number().int().positive().optional(),
  foreground_processes: z
    .array(z.object({ pid: z.number().int().positive(), name: z.string() }))
    .max(256),
});
export const HerdrObservationSchema = z.object({
  server_ref: z.string().uuid(),
  server_instance: z.string(),
  pane_id: z.string(),
  terminal_id: z.string(),
  native_session_id: z.string(),
  owner: ProcessIdentitySchema,
});
export type HerdrObservation = z.infer<typeof HerdrObservationSchema>;
