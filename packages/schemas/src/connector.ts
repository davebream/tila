import { z } from "zod";
import { AgentIdSchema } from "./agent";
import { ProcessIdentitySchema } from "./lifecycle";

export const HerdrPaneSchema = z.object({
  pane_id: z.string(),
  terminal_id: z.string(),
  agent: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  agent_status: z.string(),
  agent_session: z
    .object({
      source: z.string(),
      agent: z.string(),
      kind: z.enum(["id", "path"]),
      value: z.string(),
    })
    .nullish()
    .transform((value) => value ?? undefined),
  revision: z.number().int().nonnegative(),
});
export const HerdrSnapshotSchema = z.object({
  version: z.string(),
  protocol: z.number().int(),
  panes: z.array(HerdrPaneSchema).max(4096),
});
export const HerdrProcessInfoSchema = z.object({
  pane_id: z.string(),
  shell_pid: z
    .number()
    .int()
    .positive()
    .nullish()
    .transform((value) => value ?? undefined),
  foreground_processes: z
    .array(z.object({ pid: z.number().int().positive(), name: z.string() }))
    .max(256)
    .default([]),
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

export const HerdrSelectorSchema = z
  .object({
    kind: z.literal("herdr"),
    socket: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => value.startsWith("/") && !value.includes("\0")),
    paneId: z.string().min(1).max(128),
  })
  .strict();
export const RuntimeSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standalone") }).strict(),
  HerdrSelectorSchema,
]);
export type RuntimeSelector = z.infer<typeof RuntimeSelectorSchema>;
export const RuntimeAssociationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standalone") }).strict(),
  z
    .object({
      kind: z.literal("herdr"),
      socket: z.string(),
      observation: HerdrObservationSchema,
    })
    .strict(),
]);
export type RuntimeAssociation = z.infer<typeof RuntimeAssociationSchema>;

export const RegistrationV1Schema = z.object({
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
export const RegistrationSchema = RegistrationV1Schema.extend({
  runtime: RuntimeAssociationSchema,
  identity: z
    .object({
      nativeSessionId: z.string(),
      harness: z.enum(["claude-code", "codex"]),
      participantId: z.string(),
      enrollmentId: z.string(),
      projectId: z.string(),
      instanceId: z.string(),
      accountRef: z.string(),
      principalId: z.string(),
      brokerRef: z.string().regex(/^[a-f0-9]{64}$/),
      nativeEndpointRef: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .optional(), // Migrated v1 rows acquire no invented evidence.
});
export type Registration = z.infer<typeof RegistrationSchema>;
export const LedgerV1Schema = z.object({
  version: z.literal(1),
  hostRef: z.string().uuid(),
  heartbeat: z.number(),
  registrations: z.array(RegistrationV1Schema.strict()).max(32),
});
export const LedgerV2Schema = z.object({
  version: z.literal(2),
  hostRef: z.string().uuid(),
  heartbeat: z.number(),
  registrations: z.array(RegistrationSchema.strict()).max(32),
});
export const LedgerSchema = z.union([
  LedgerV2Schema,
  LedgerV1Schema.strict().transform((ledger) => ({
    ...ledger,
    version: 2 as const,
    registrations: ledger.registrations.map((entry) => ({
      ...entry,
      runtime: { kind: "standalone" as const },
    })),
  })),
]);
export type Ledger = z.infer<typeof LedgerV2Schema>;

export const ControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("inspect-herdr-registrations") }).strict(),
  z
    .object({
      action: z.literal("register"),
      key: z.string().regex(/^[a-f0-9]{64}$/),
      expectedEpoch: z.number().int().nonnegative(),
      allowIdleStart: z.boolean().default(false),
      target: RuntimeSelectorSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("inspect-herdr"),
      key: z.string().regex(/^[a-f0-9]{64}$/),
      target: HerdrSelectorSchema,
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
