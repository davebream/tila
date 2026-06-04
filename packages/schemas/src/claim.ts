import { z } from "zod";

export const ClaimModeSchema = z.enum(["exclusive", "owner", "presence"]);

export type ClaimMode = z.infer<typeof ClaimModeSchema>;

export const ClaimSchema = z.object({
  resource: z.string(),
  machine: z.string(),
  user: z.string(),
  mode: ClaimModeSchema,
  fence: z.number().int(),
  acquired_at: z.number().int(),
  expires_at: z.number().int(),
  metadata: z.record(z.unknown()).optional(),
});

export type Claim = z.infer<typeof ClaimSchema>;
