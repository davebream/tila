import { z } from "zod";
import { InstanceKey } from "./instance-registry";

// --- CredentialRecord ---
// One stored OAuth/API credential per instance, keyed by instance_key.
// Lives only in the OS keychain — never written to disk.
export const CredentialRecordSchema = z.object({
  instance_key: InstanceKey,
  token: z.string(),
  token_type: z.string(),
  expires_at: z.number().int().nullable(), // epoch ms; null = unknown/non-expiring
  scope: z.string().optional(),
  obtained_at: z.number().int(), // epoch ms
});

export type CredentialRecord = z.infer<typeof CredentialRecordSchema>;
