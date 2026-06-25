import { z } from "zod";

// --- InstanceKey branded string ---
// A stable, immutable identifier for a tila instance. Set once from the server
// instance_id (instance_id_source: "server") or a client-generated UUID
// (instance_id_source: "client-uuid"). Pinned immutably after first registration.
export const InstanceKey = z.string().brand<"InstanceKey">();
export type InstanceKey = z.infer<typeof InstanceKey>;

// --- InstanceRecord ---
// A single registered tila instance entry in ~/.tila/instances.toml.
export const InstanceRecordSchema = z.object({
  instance_key: InstanceKey,
  label: z.string().optional(),
  worker_url: z.string().url(),
  instance_id_source: z.enum(["server", "client-uuid"]),
  trust: z.object({
    trusted: z.boolean(),
    trusted_at: z.number().int().nullable(), // epoch ms
  }),
  created_at: z.number().int(), // epoch ms
});

export type InstanceRecord = z.infer<typeof InstanceRecordSchema>;

// --- InstanceRegistrySchema ---
// The full ~/.tila/instances.toml structure.
export const InstanceRegistrySchema = z.object({
  version: z.number().int(),
  current_context: InstanceKey.nullable(),
  instances: z.array(InstanceRecordSchema),
});

export type InstanceRegistry = z.infer<typeof InstanceRegistrySchema>;
