import { z } from "zod";

export const ProjectMembershipModeSchema = z.enum([
  "explicit",
  "github-mirrored",
  "hybrid",
  "service-only",
]);
export type ProjectMembershipMode = z.infer<typeof ProjectMembershipModeSchema>;

export const ProjectRoleSchema = z.enum([
  "viewer",
  "participant",
  "maintainer",
  "owner",
]);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const MembershipSubjectKindSchema = z.enum(["human", "service"]);
export type MembershipSubjectKind = z.infer<typeof MembershipSubjectKindSchema>;

export const MembershipSourceSchema = z.enum([
  "explicit",
  "github-mirrored",
  "bootstrap",
]);
export type MembershipSource = z.infer<typeof MembershipSourceSchema>;

export const MembershipPrincipalSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    host: z.string().min(1).default("github.com"),
    user_id: z.number().int().positive(),
    login: z.string().min(1).max(255).optional(),
  }),
  z.object({
    provider: z.literal("oidc"),
    issuer: z.string().url(),
    subject: z.string().min(1).max(255),
  }),
]);
export type MembershipPrincipal = z.infer<typeof MembershipPrincipalSchema>;

export const PrincipalRevocationRequestSchema = z.object({
  principal: MembershipPrincipalSchema,
  revoke_tokens: z.array(z.string().min(1).max(255)).max(50).optional(),
});
export type PrincipalRevocationRequest = z.infer<
  typeof PrincipalRevocationRequestSchema
>;

export const MembershipGrantRequestSchema = z
  .object({
    principal: MembershipPrincipalSchema,
    subject_kind: MembershipSubjectKindSchema,
    role: ProjectRoleSchema,
    display_name: z.string().min(1).max(255).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.principal.provider === "github" &&
      value.subject_kind !== "human"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GitHub principals must have subject_kind human",
        path: ["subject_kind"],
      });
    }
  });
export type MembershipGrantRequest = z.infer<
  typeof MembershipGrantRequestSchema
>;

export const MembershipRoleUpdateRequestSchema = z.object({
  role: ProjectRoleSchema,
});
export type MembershipRoleUpdateRequest = z.infer<
  typeof MembershipRoleUpdateRequestSchema
>;

export const MembershipPolicyRequestSchema = z.object({
  mode: ProjectMembershipModeSchema,
});
export type MembershipPolicyRequest = z.infer<
  typeof MembershipPolicyRequestSchema
>;

export const ProjectMembershipSchema = z.object({
  membership_id: z.string().uuid(),
  project_id: z.string().min(1),
  principal_id: z.string().min(1),
  provider: z.enum(["github", "oidc"]),
  identity_host: z.string().min(1),
  subject_id: z.string().min(1),
  subject_kind: MembershipSubjectKindSchema,
  role: ProjectRoleSchema,
  display_name: z.string().nullable(),
  granted_by: z.string().min(1),
  granted_at: z.number().int(),
  revoked_by: z.string().nullable(),
  revoked_at: z.number().int().nullable(),
});
export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;

export function roleToPermission(
  role: ProjectRole,
): "read" | "write" | "admin" {
  if (role === "viewer") return "read";
  if (role === "participant") return "write";
  return "admin";
}

export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  participant: 2,
  maintainer: 3,
  owner: 4,
};
