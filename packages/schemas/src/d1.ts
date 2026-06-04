import { z } from "zod";

// --- D1 Global: _projects ---

export const D1ProjectSchema = z.object({
  project_id: z.string(),
  display_name: z.string().nullable(),
  created_at: z.number().int(),
  created_by: z.string(),
  cloudflare_account_id: z.string(),
  schema_version: z.number().int(),
  archived: z.number().int().default(0),
});

export type D1Project = z.infer<typeof D1ProjectSchema>;

// --- D1 Global: _tokens ---

export const D1TokenSchema = z.object({
  token_hash: z.string(),
  project_id: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  scopes: z.string(), // "full" in v0.1
  created_at: z.number().int(),
  created_by: z.string(),
  last_used_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
  revoked_by: z.string().nullable(),
});

export type D1Token = z.infer<typeof D1TokenSchema>;

// --- D1 Global: _idempotency ---

export const D1IdempotencySchema = z.object({
  key: z.string(),
  project_id: z.string(),
  created_at: z.number().int(),
  response_json: z.string(),
  status_code: z.number().int(),
  request_hash: z.string().nullable().optional(),
});

export type D1Idempotency = z.infer<typeof D1IdempotencySchema>;
