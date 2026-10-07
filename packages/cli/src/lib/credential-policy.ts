import {
  CREDENTIAL_PRESETS,
  type CredentialPolicy,
  CredentialPolicySchema,
} from "@tila/schemas";

export const credentialPolicyArgs = {
  preset: {
    type: "string" as const,
    description: "read-only, coordination-only, or artifact-writer",
    default: "read-only",
  },
  role: { type: "string" as const, description: "Credential role ceiling" },
  capabilities: {
    type: "string" as const,
    description: "Comma-separated explicit capabilities (replaces preset)",
  },
  restrictions: {
    type: "string" as const,
    description: "JSON task_types and records namespace restrictions",
  },
};
export function policyFromArgs(
  args: Record<string, unknown>,
): CredentialPolicy {
  const name = String(args.preset ?? "read-only");
  if (!Object.hasOwn(CREDENTIAL_PRESETS, name))
    throw new Error("Unknown credential preset");
  const preset = CREDENTIAL_PRESETS[name as keyof typeof CREDENTIAL_PRESETS];
  return CredentialPolicySchema.parse({
    ...preset,
    ...(args.role ? { role: args.role } : {}),
    ...(args.capabilities !== undefined
      ? { capabilities: String(args.capabilities).split(",").filter(Boolean) }
      : {}),
    ...(args.restrictions
      ? { restrictions: JSON.parse(String(args.restrictions)) }
      : {}),
  });
}
