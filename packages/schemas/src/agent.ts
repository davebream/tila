import { z } from "zod";

export const AgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const AgentNameSchema = z.string().min(1).max(100);
const BindPolicySchema = z
  .array(
    z
      .object({
        principal_id: z.string().min(1).max(256),
        agent_id: AgentIdSchema,
      })
      .strict(),
  )
  .max(100);
export const AgentRegistrationSchema = z
  .object({
    id: AgentIdSchema,
    name: AgentNameSchema,
    bind_policy: BindPolicySchema.default([]),
  })
  .strict()
  .refine(
    (value) => value.bind_policy.every((grant) => grant.agent_id === value.id),
    {
      message: "Binding grants must name this agent",
    },
  );
/**
 * Configured, non-secret launch selection. It names a host-local profile and,
 * optionally, the enrollment (`host_ref`) and account reference a new binding
 * must report. It is never a credential and never rewrites binding evidence.
 */
export const AgentProfileSelectionSchema = z
  .object({
    profile_id: AgentIdSchema,
    host_ref: z.string().min(1).max(256).nullable().default(null),
    account_ref: z.string().min(1).max(256).nullable().default(null),
  })
  .strict();
export const AgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  owner_principal_id: z.string(),
  bind_policy: z.array(
    z.object({ principal_id: z.string(), agent_id: AgentIdSchema }),
  ),
  binding_epoch: z.number().int().nonnegative(),
  archived: z.boolean(),
  // Defaults keep a newer client readable against a pre-#298 Worker; 0 means
  // the server reported no revision, so every conditional write conflicts.
  revision: z.number().int().nonnegative().default(0),
  profile_selection: AgentProfileSelectionSchema.nullable().default(null),
  created_at: z.number(),
  updated_at: z.number(),
});
export const UpdateAgentSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    name: AgentNameSchema.optional(),
    bind_policy: BindPolicySchema.optional(),
    profile_selection: AgentProfileSelectionSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.bind_policy !== undefined ||
      value.profile_selection !== undefined,
    { message: "Provide name, bind_policy or profile_selection" },
  );
export const ArchiveAgentSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    // Required when the agent has an active binding: the reviewed occupant.
    expected_epoch: z.number().int().nonnegative().optional(),
  })
  .strict();
export const UnarchiveAgentSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;
export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;
export type AgentProfileSelection = z.infer<typeof AgentProfileSelectionSchema>;
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;
export type ArchiveAgent = z.infer<typeof ArchiveAgentSchema>;
