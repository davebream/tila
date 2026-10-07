import { z } from "zod";
import {
  PROJECT_ROLE_RANK,
  type ProjectRole,
  ProjectRoleSchema,
} from "./membership";
import { RecordKeySchema, RecordTypeSchema } from "./record";

export const CAPABILITIES = [
  "tasks:read",
  "tasks:write",
  "tasks:delete",
  "records:read",
  "records:write",
  "records:delete",
  "artifacts:read",
  "artifacts:write",
  "artifacts:delete",
  "claims:read",
  "claims:acquire",
  "claims:renew",
  "claims:release",
  "signals:read",
  "signals:send",
  "signals:ack",
  "signals:manage",
  "presence:read",
  "presence:heartbeat",
  "gates:read",
  "gates:create",
  "gates:resolve",
  "gates:delete",
  "schema:read",
  "schema:preview",
  "schema:write",
  "search:read",
  "search:reindex",
  "journal:read",
  "journal:archive",
  "summary:read",
  "templates:instantiate",
  "tokens:read",
  "tokens:issue",
  "tokens:rotate",
  "tokens:revoke",
  "service-accounts:read",
  "service-accounts:manage",
  "workload-bindings:read",
  "workload-bindings:manage",
  "memberships:read",
  "memberships:manage",
  "repository-policy:read",
  "repository-policy:manage",
  "project:inspect",
  "project:restart",
  "project:export",
  "project:import",
  "project:archive",
  "project:destroy",
  "project:sessions-revoke",
  "project:principals-revoke",
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;
export const NamespaceRestrictionsSchema = z
  .object({
    task_types: z.array(z.string().min(1)).max(100).optional(),
    records: z
      .array(
        z
          .object({
            type: RecordTypeSchema,
            key_prefixes: z.array(RecordKeySchema).max(100).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export type NamespaceRestrictions = z.infer<typeof NamespaceRestrictionsSchema>;
export const CredentialPolicySchema = z
  .object({
    role: ProjectRoleSchema,
    capabilities: z.array(CapabilitySchema).max(CAPABILITIES.length),
    restrictions: NamespaceRestrictionsSchema.optional(),
  })
  .strict();
export type CredentialPolicy = z.infer<typeof CredentialPolicySchema>;

export function capabilityRole(capability: Capability): ProjectRole {
  const [resource, action] = capability.split(":");
  if (
    [
      "tokens",
      "service-accounts",
      "workload-bindings",
      "memberships",
      "repository-policy",
    ].includes(resource)
  )
    return "owner";
  if (resource === "project")
    return ["inspect", "restart", "sessions-revoke"].includes(action)
      ? "maintainer"
      : "owner";
  if (
    [
      "schema:write",
      "signals:manage",
      "search:reindex",
      "journal:archive",
    ].includes(capability)
  )
    return "maintainer";
  return action === "read" ? "viewer" : "participant";
}

export function effectiveCredentialPolicy(
  policy: CredentialPolicy,
  membership: ProjectRole,
): CredentialPolicy {
  const role =
    PROJECT_ROLE_RANK[policy.role] <= PROJECT_ROLE_RANK[membership]
      ? policy.role
      : membership;
  return {
    ...policy,
    role,
    capabilities: policy.capabilities.filter(
      (cap) =>
        PROJECT_ROLE_RANK[capabilityRole(cap)] <= PROJECT_ROLE_RANK[role],
    ),
  };
}

export const CREDENTIAL_PRESETS = {
  "read-only": {
    role: "viewer",
    capabilities: CAPABILITIES.filter(
      (cap) => cap.endsWith(":read") && capabilityRole(cap) === "viewer",
    ),
  },
  "coordination-only": {
    role: "participant",
    capabilities: [
      "claims:read",
      "claims:acquire",
      "claims:renew",
      "claims:release",
      "signals:read",
      "signals:send",
      "signals:ack",
      "presence:read",
      "presence:heartbeat",
      "gates:read",
      "gates:create",
      "gates:resolve",
    ],
  },
  "artifact-writer": {
    role: "participant",
    capabilities: ["artifacts:read", "artifacts:write"],
  },
} satisfies Record<string, CredentialPolicy>;

export function permitsTask(
  restrictions: NamespaceRestrictions | undefined,
  type: string,
): boolean {
  return (
    restrictions?.task_types === undefined ||
    restrictions.task_types.includes(type)
  );
}
export function permitsRecord(
  restrictions: NamespaceRestrictions | undefined,
  type: string,
  key: string,
): boolean {
  return (
    restrictions?.records === undefined ||
    restrictions.records.some(
      (rule) =>
        rule.type === type &&
        (rule.key_prefixes === undefined ||
          rule.key_prefixes.some(
            (prefix) => key === prefix || key.startsWith(`${prefix}/`),
          )),
    )
  );
}
export function hasNamespaceRestrictions(policy: CredentialPolicy): boolean {
  return (
    policy.restrictions?.task_types !== undefined ||
    policy.restrictions?.records !== undefined
  );
}

/** True only when every grant in child is contained in parent. */
export function policyContains(
  parent: CredentialPolicy,
  child: CredentialPolicy,
): boolean {
  if (
    PROJECT_ROLE_RANK[child.role] > PROJECT_ROLE_RANK[parent.role] ||
    child.capabilities.some((cap) => !parent.capabilities.includes(cap))
  )
    return false;
  const p = parent.restrictions;
  const c = child.restrictions;
  if (
    p?.task_types !== undefined &&
    (c?.task_types === undefined ||
      c.task_types.some((type) => !p.task_types?.includes(type)))
  )
    return false;
  if (p?.records !== undefined) {
    if (c?.records === undefined) return false;
    for (const rule of c.records) {
      if (rule.key_prefixes === undefined) {
        if (
          !p.records.some(
            (allowed) =>
              allowed.type === rule.type && allowed.key_prefixes === undefined,
          )
        )
          return false;
      } else if (
        rule.key_prefixes.some((prefix) => !permitsRecord(p, rule.type, prefix))
      )
        return false;
    }
  }
  return true;
}

export const ServiceAccountCreateRequestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    display_name: z.string().min(1).max(255),
    role: ProjectRoleSchema.default("viewer"),
  })
  .strict();
export const ServiceAccountUpdateRequestSchema = z
  .object({ display_name: z.string().min(1).max(255) })
  .strict();
export const ServiceAccountSchema = z.object({
  principal_id: z.string(),
  project_id: z.string(),
  name: z.string(),
  display_name: z.string(),
  created_at: z.number().int(),
  created_by: z.string(),
  revoked_at: z.number().int().nullable(),
});
export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;
export const TokenRotateRequestSchema = z
  .object({
    expected_token_id: z.string().uuid(),
    overlap_seconds: z.number().int().min(0).max(86400).default(0),
  })
  .strict();
export const WorkloadBindingRequestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    provider: z.enum(["github-actions", "oidc"]),
    issuer: z.string().url(),
    subject: z.string().min(1).max(255),
    policy: CredentialPolicySchema,
  })
  .strict();
export type WorkloadBindingRequest = z.infer<
  typeof WorkloadBindingRequestSchema
>;

export const WorkloadBindingUpdateRequestSchema = z
  .object({ policy: CredentialPolicySchema })
  .strict();

/** Current authority can narrow, but never expand, an already issued session. */
export function intersectCredentialPolicies(
  a: CredentialPolicy,
  b: CredentialPolicy,
): CredentialPolicy {
  const tasksA = a.restrictions?.task_types;
  const tasksB = b.restrictions?.task_types;
  const recordsA = a.restrictions?.records;
  const recordsB = b.restrictions?.records;
  const records =
    recordsA === undefined
      ? recordsB
      : recordsB === undefined
        ? recordsA
        : recordsA.flatMap((left) =>
            recordsB
              .filter((right) => right.type === left.type)
              .map((right) => {
                const key_prefixes =
                  left.key_prefixes === undefined
                    ? right.key_prefixes
                    : right.key_prefixes === undefined
                      ? left.key_prefixes
                      : left.key_prefixes.flatMap((x) =>
                          (right.key_prefixes ?? []).flatMap((y) =>
                            x === y || x.startsWith(`${y}/`)
                              ? [x]
                              : y.startsWith(`${x}/`)
                                ? [y]
                                : [],
                          ),
                        );
                return {
                  type: left.type,
                  ...(key_prefixes === undefined
                    ? {}
                    : { key_prefixes: [...new Set(key_prefixes)] }),
                };
              }),
          );
  const task_types =
    tasksA === undefined
      ? tasksB
      : tasksB === undefined
        ? tasksA
        : tasksA.filter((type) => tasksB.includes(type));
  const policy = effectiveCredentialPolicy(
    {
      ...a,
      capabilities: a.capabilities.filter((cap) =>
        b.capabilities.includes(cap),
      ),
    },
    b.role,
  );
  return {
    ...policy,
    restrictions: {
      ...(task_types === undefined ? {} : { task_types }),
      ...(records === undefined ? {} : { records }),
    },
  };
}
