import { z } from "zod";
import { InstanceKey } from "./instance-registry";

// --- RefreshRecord ---
// Refresh token for a given instance, keyed by instance_key.
// Lives only in the OS keychain — never written to disk.
export const RefreshRecordSchema = z.object({
  instance_key: InstanceKey,
  refresh_token: z.string(),
  expires_at: z.number().int().nullable(), // epoch ms; null = non-expiring
  obtained_at: z.number().int(), // epoch ms
});

export type RefreshRecord = z.infer<typeof RefreshRecordSchema>;
