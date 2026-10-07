import { z } from "zod";
import {
  AcquireRequestSchema,
  ArtifactTextWriteRequestSchema,
  CreateEntityRequestSchema,
  RecordCreateRequestSchema,
  RecordSetRequestSchema,
  ReleaseRequestSchema,
  RenewRequestSchema,
  UpdateEntityRequestSchema,
} from "./api";
import {
  HandoffCreateRequestSchema,
  JournalAcknowledgeRequestSchema,
  JournalReplayRequestSchema,
  ReentryRequestSchema,
} from "./continuity";
import { SendSignalRequestSchema, SignalTargetSchema } from "./signal";

export const McpRecoverySchema = z.object({
  code: z.string(),
  message: z.string(),
  recovery_action: z.string(),
  retry_safety: z.enum(["safe", "after_recovery", "unsafe", "unknown"]),
});
export type McpRecovery = z.infer<typeof McpRecoverySchema>;
const id = z.string().min(1);
const action = <T extends string>(value: T) => z.literal(value);
export const SessionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: action("open"),
      ...ReentryRequestSchema.innerType().shape,
    })
    .strict(),
  z
    .object({
      action: action("heartbeat"),
      info: z.record(z.unknown()).default({}),
    })
    .strict(),
  JournalAcknowledgeRequestSchema.extend({
    action: action("acknowledge"),
  }).strict(),
]);
export const InspectRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: action("ready"), type: id.optional() }).strict(),
  z
    .object({
      action: action("task"),
      id,
      limit: z.number().int().min(1).max(500).default(50),
    })
    .strict(),
  z.object({ action: action("record"), type: id, key: id }).strict(),
  z
    .object({
      action: action("artifact"),
      key: id,
      max_chars: z.number().int().min(1).max(100000).default(10000),
    })
    .strict(),
  z.object({ action: action("handoff"), id: z.string().uuid() }).strict(),
  z.object({ action: action("participants") }).strict(),
  z
    .object({
      action: action("search"),
      q: id,
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  JournalReplayRequestSchema.extend({ action: action("changes") }).strict(),
]);
export const ClaimRequestSchema = z.discriminatedUnion("action", [
  AcquireRequestSchema.extend({
    action: action("acquire"),
    resource: id,
    mode: AcquireRequestSchema.shape.mode.default("exclusive"),
    ttl_ms: AcquireRequestSchema.shape.ttl_ms.default(300000),
  }).strict(),
  RenewRequestSchema.extend({ action: action("renew"), resource: id }).strict(),
  ReleaseRequestSchema.extend({
    action: action("release"),
    resource: id,
  }).strict(),
]);
export const PublishRequestSchema = z.discriminatedUnion("action", [
  CreateEntityRequestSchema.extend({ action: action("task_create") }).strict(),
  UpdateEntityRequestSchema.omit({ tags: true })
    .extend({ action: action("task_update"), id })
    .strict(),
  RecordCreateRequestSchema.extend({
    action: action("record_create"),
    type: id,
  }).strict(),
  RecordSetRequestSchema.extend({
    action: action("record_set"),
    type: id,
    key: id,
  }).strict(),
  ArtifactTextWriteRequestSchema.extend({
    action: action("artifact_text"),
    idempotency_key: z.string().uuid().optional(),
  }).strict(),
]);
export const SignalRequestSchema = z.discriminatedUnion("action", [
  SendSignalRequestSchema.extend({
    action: action("send"),
    target: SignalTargetSchema.options[0],
  }).strict(),
  z.object({ action: action("inbox") }).strict(),
  z.object({ action: action("acknowledge"), id }).strict(),
]);
export const CloseRequestSchema = z
  .object({
    handoff: HandoffCreateRequestSchema,
    release: z.array(ReleaseRequestSchema.strict()).max(100).default([]),
  })
  .strict();
