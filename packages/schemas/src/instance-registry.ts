import { z } from "zod";

// --- CredentialProviderConfigSchema ---
// Per-instance credential provider configuration. Optional field on InstanceRecord.
// Controls which provider kind is used to acquire credentials for this instance.
// Absent → fall back to the project auth.mode enum (github-repo → github, tila-token → tila-token).
// exec and oidc-generic can only be selected via an explicit entry here (never from auth.mode).
export const CredentialProviderConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github") }),
  z.object({
    kind: z.literal("oidc-generic"),
    issuer: z.string().url(),
    client_id: z.string(),
    scope: z.string().optional(),
    audience: z.string().optional(),
  }),
  z.object({ kind: z.literal("tila-token") }),
  z.object({
    kind: z.literal("exec"),
    command: z.string(),
    args: z.array(z.string()).default([]),
  }),
]);

export type CredentialProviderConfig = z.infer<
  typeof CredentialProviderConfigSchema
>;

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
  // Optional credential provider config — absent = fall back to project auth.mode.
  // Version bump is NOT needed: this is a forward/backward-compatible optional field.
  credential_provider: CredentialProviderConfigSchema.optional(),
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
