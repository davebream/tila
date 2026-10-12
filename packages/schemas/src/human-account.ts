import { z } from "zod";
import { CredentialPolicySchema } from "./capability";
import { ProjectRoleSchema } from "./membership";
export const HumanInvitationRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  role: z.enum(["user", "admin"]).default("user"),
  projectId: z.string().min(1).max(128).optional(),
  projectRole: ProjectRoleSchema.default("participant"),
  sendEmail: z.boolean().default(false),
});
export const HumanInvitationAcceptSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
});
export const HumanUserUpdateSchema = z
  .object({
    role: z.enum(["user", "admin"]).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.disabled !== undefined);
export const HumanProjectSelectSchema = z.object({
  project_id: z.string().min(1).max(128),
});
export const HumanTokenIssueSchema = z.object({
  projectId: z.string().min(1).max(128),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/),
  policy: CredentialPolicySchema,
  expiresAt: z.number().int().positive(),
});

export const HumanRecoveryRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
});
export const HumanRecoveryAcceptSchema = HumanInvitationAcceptSchema.pick({
  token: true,
  password: true,
});
export const HumanAccountUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  role: z.enum(["admin", "user"]),
  disabled: z.boolean().optional(),
});
export type HumanAccountUser = z.infer<typeof HumanAccountUserSchema>;
export const HumanAccountInfoSchema = z.object({
  user: HumanAccountUserSchema,
  sessionId: z.string(),
  sessions: z.array(
    z.object({
      id: z.string(),
      device: z.boolean(),
      name: z.string().nullable(),
      createdAt: z.string(),
      expiresAt: z.string(),
      userAgent: z.string().nullable(),
    }),
  ),
});
export type HumanAccountInfo = z.infer<typeof HumanAccountInfoSchema>;
