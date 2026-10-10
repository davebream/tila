import { z } from "zod";

export const AgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const AgentRegistrationSchema = z
  .object({
    id: AgentIdSchema,
    name: z.string().min(1).max(100),
    bind_policy: z
      .array(
        z
          .object({
            principal_id: z.string().min(1).max(256),
            agent_id: AgentIdSchema,
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict()
  .refine(
    (value) => value.bind_policy.every((grant) => grant.agent_id === value.id),
    {
      message: "Binding grants must name this agent",
    },
  );
export const AgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  owner_principal_id: z.string(),
  bind_policy: z.array(
    z.object({ principal_id: z.string(), agent_id: AgentIdSchema }),
  ),
  binding_epoch: z.number().int().nonnegative(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Agent = z.infer<typeof AgentSchema>;
export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;
