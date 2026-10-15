import {
  CREDENTIAL_PRESETS,
  type CredentialPolicy,
  CredentialPolicySchema,
} from "@tila/schemas";
import { cliError } from "./schema-transfer";

const RESTRICTIONS_HINT =
  'Records take either "records" (reads and writes alike) or "records_read" and "records_write" (separate lists); see --help.';

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
    description:
      'JSON object: "task_types" limits task types; records use "records" (one rule list that applies to reads and writes) or "records_read" and "records_write" (separate lists), never both. Once either split list is present, a side that is left out or empty denies every record. A rule is {"type": "answer", "key_prefixes": ["a1"]}. Example: {"records_read":[{"type":"answer","key_prefixes":["a1"]}],"records_write":[{"type":"question"}]}',
  },
};

function parseRestrictions(raw: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw cliError(
      "invalid-argument",
      `--restrictions is not valid JSON: ${(error as Error).message}`,
      RESTRICTIONS_HINT,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw cliError(
      "invalid-argument",
      '--restrictions must be a JSON object such as {"task_types":["bug"]} or {"records_read":[{"type":"answer"}],"records_write":[]}',
      RESTRICTIONS_HINT,
    );
  return value;
}

export function policyFromArgs(
  args: Record<string, unknown>,
): CredentialPolicy {
  const name = String(args.preset ?? "read-only");
  if (!Object.hasOwn(CREDENTIAL_PRESETS, name))
    throw new Error("Unknown credential preset");
  const preset = CREDENTIAL_PRESETS[name as keyof typeof CREDENTIAL_PRESETS];
  const parsed = CredentialPolicySchema.safeParse({
    ...preset,
    ...(args.role ? { role: args.role } : {}),
    ...(args.capabilities !== undefined
      ? { capabilities: String(args.capabilities).split(",").filter(Boolean) }
      : {}),
    ...(args.restrictions
      ? { restrictions: parseRestrictions(String(args.restrictions)) }
      : {}),
  });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path ?? [];
  const message = issue?.message ?? "invalid";
  if (path[0] !== "restrictions")
    throw cliError(
      "invalid-argument",
      `Invalid policy: ${path.join(".") || "policy"}: ${message}`,
      "Check --preset, --role and --capabilities against --help.",
    );
  // The cross-field message already names the fields, so it needs no path.
  const where = path.slice(1).join(".");
  throw cliError(
    "invalid-argument",
    `Invalid --restrictions: ${
      where === "" || message.startsWith("restrictions.")
        ? message
        : `${where}: ${message}`
    }`,
    RESTRICTIONS_HINT,
  );
}
