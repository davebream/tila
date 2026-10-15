import { CheckboxField } from "@/components/definitions/controls";
import { uniqueLines } from "@/components/settings/settings-ui";
import { SelectField, TextAreaField } from "@/components/ui/form-fields";
import {
  CAPABILITIES,
  CREDENTIAL_PRESETS,
  type Capability,
  type CredentialPolicy,
  CredentialPolicySchema,
  ROOT_CAPABILITIES,
  type RecordRestrictionRule,
  RecordRestrictionRuleSchema,
} from "@tila/schemas";
import { z } from "zod";

/**
 * Record rules that limit reading and writing separately. The form cannot
 * author them, so it carries them as they are and writes them back unchanged.
 */
const SplitRecords = z.object({
  records_read: z.array(RecordRestrictionRuleSchema).optional(),
  records_write: z.array(RecordRestrictionRuleSchema).optional(),
});
type SplitRecords = z.infer<typeof SplitRecords>;

/**
 * A credential policy as the forms edit it: a preset or a custom role and
 * capability list, plus optional namespace restrictions written one per line.
 * Over-broad policies are left for the server to refuse with its own message.
 * A policy that limits record reads and writes separately keeps those rules in
 * `records_split` untouched; `records` is then empty and not editable.
 */
export const PolicyForm = z.object({
  preset: z.string(),
  role: z.enum(["viewer", "participant", "maintainer", "owner"]),
  capabilities: z.array(z.string()),
  task_types: z.string(),
  records: z.string(),
  records_split: SplitRecords.optional(),
});
export type PolicyForm = z.infer<typeof PolicyForm>;

type Preset = keyof typeof CREDENTIAL_PRESETS;
const PRESETS = Object.keys(CREDENTIAL_PRESETS) as Preset[];
const CUSTOM = "custom";

/** Root capabilities are never delegable, so they are not offered. */
const DELEGABLE = CAPABILITIES.filter((cap) => !ROOT_CAPABILITIES.has(cap));
const GROUPS = [...new Set(DELEGABLE.map((cap) => cap.split(":")[0]))].map(
  (resource) => ({
    resource,
    capabilities: DELEGABLE.filter((cap) => cap.startsWith(`${resource}:`)),
  }),
);

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

export function presetForm(preset: Preset = "read-only"): PolicyForm {
  const policy = CREDENTIAL_PRESETS[preset];
  return {
    preset,
    role: policy.role,
    capabilities: [...policy.capabilities],
    task_types: "",
    records: "",
  };
}

export function policyToForm(policy: CredentialPolicy): PolicyForm {
  const { records_read, records_write } = policy.restrictions ?? {};
  const split: SplitRecords | undefined =
    records_read === undefined && records_write === undefined
      ? undefined
      : {
          ...(records_read === undefined ? {} : { records_read }),
          ...(records_write === undefined ? {} : { records_write }),
        };
  const preset =
    !policy.restrictions &&
    PRESETS.find(
      (name) =>
        CREDENTIAL_PRESETS[name].role === policy.role &&
        sameSet(CREDENTIAL_PRESETS[name].capabilities, policy.capabilities),
    );
  return {
    preset: preset || CUSTOM,
    role: policy.role,
    capabilities: [...policy.capabilities],
    task_types: (policy.restrictions?.task_types ?? []).join("\n"),
    records: (policy.restrictions?.records ?? [])
      .flatMap((rule) =>
        rule.key_prefixes === undefined
          ? [rule.type]
          : rule.key_prefixes.map((prefix) => `${rule.type}/${prefix}`),
      )
      .join("\n"),
    ...(split === undefined ? {} : { records_split: split }),
  };
}

/** One line per rule, prefixed by its side, for showing a split policy. */
function splitRecordLines(split: SplitRecords): string {
  const lines = (side: string, rules: RecordRestrictionRule[] | undefined) =>
    rules === undefined || rules.length === 0
      ? [`${side}: none`]
      : rules.flatMap((rule) =>
          rule.key_prefixes === undefined
            ? [`${side}: ${rule.type}`]
            : rule.key_prefixes.length === 0
              ? [`${side}: ${rule.type} (no keys)`]
              : rule.key_prefixes.map(
                  (prefix) => `${side}: ${rule.type}/${prefix}`,
                ),
        );
  return [
    ...lines("read", split.records_read),
    ...lines("write", split.records_write),
  ].join("\n");
}

/** The policy a form describes; `problem` explains why it is invalid. */
export function formToPolicy(
  form: PolicyForm,
): { policy: CredentialPolicy; problem: null } | { problem: string } {
  const task_types = uniqueLines(form.task_types);
  // A split policy is written back exactly as it was read. The two forms
  // cannot be combined, so a record list next to it is refused, never merged.
  if (form.records_split && uniqueLines(form.records).length > 0)
    return {
      problem:
        "records: this policy limits record reads and writes separately; clear the record list",
    };
  const rules = new Map<string, { whole: boolean; prefixes: string[] }>();
  for (const line of uniqueLines(form.records)) {
    const slash = line.indexOf("/");
    const type = slash < 0 ? line : line.slice(0, slash);
    const prefix = slash < 0 ? null : line.slice(slash + 1);
    const rule = rules.get(type) ?? { whole: false, prefixes: [] };
    if (prefix) rule.prefixes.push(prefix);
    else rule.whole = true;
    rules.set(type, rule);
  }
  const records = [...rules].map(([type, rule]) =>
    rule.whole || rule.prefixes.length === 0
      ? { type }
      : { type, key_prefixes: rule.prefixes },
  );
  const restrictions = {
    ...(task_types.length ? { task_types } : {}),
    ...(form.records_split ? form.records_split : {}),
    ...(records.length ? { records } : {}),
  };
  const parsed = CredentialPolicySchema.safeParse({
    role: form.role,
    capabilities: form.capabilities,
    ...(Object.keys(restrictions).length ? { restrictions } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      problem: `${issue?.path.join(".") || "policy"}: ${issue?.message ?? "invalid"}`,
    };
  }
  return { policy: parsed.data, problem: null };
}

/** One-line summary: "participant · 21 capabilities · tasks: bug". */
export function policySummary(policy: CredentialPolicy): string {
  const parts = [
    policy.role,
    `${policy.capabilities.length} ${policy.capabilities.length === 1 ? "capability" : "capabilities"}`,
  ];
  if (policy.restrictions?.task_types)
    parts.push(`tasks: ${policy.restrictions.task_types.join(", ")}`);
  if (policy.restrictions?.records)
    parts.push(
      `records: ${policy.restrictions.records.map((r) => r.type).join(", ")}`,
    );
  const { records_read, records_write } = policy.restrictions ?? {};
  if (records_read !== undefined || records_write !== undefined) {
    // A side that is not listed denies every record, so say so.
    const side = (rules: RecordRestrictionRule[] | undefined) =>
      rules?.length ? rules.map((rule) => rule.type).join(", ") : "none";
    parts.push(
      `records read: ${side(records_read)}`,
      `records write: ${side(records_write)}`,
    );
  }
  return parts.join(" · ");
}

export function PolicyFields({
  form,
  disabled,
  problem,
  onChange,
}: {
  form: PolicyForm;
  disabled: boolean;
  problem?: string;
  onChange: (form: PolicyForm) => void;
}) {
  const custom = (change: Partial<PolicyForm>) =>
    onChange({ ...form, ...change, preset: CUSTOM });
  return (
    <div className="space-y-3">
      <SelectField
        label="Preset"
        value={form.preset}
        disabled={disabled}
        options={[
          ...PRESETS.map((value) => ({ value })),
          { value: CUSTOM, label: "custom" },
        ]}
        hint="A preset fills the role and capabilities; changing either makes the policy custom."
        onChange={(e) => {
          const value = e.target.value;
          if (value === CUSTOM) onChange({ ...form, preset: CUSTOM });
          else
            onChange({
              ...presetForm(value as Preset),
              task_types: form.task_types,
              records: form.records,
              ...(form.records_split
                ? { records_split: form.records_split }
                : {}),
            });
        }}
      />
      <SelectField
        label="Role ceiling"
        value={form.role}
        disabled={disabled}
        options={["viewer", "participant", "maintainer", "owner"].map(
          (value) => ({ value }),
        )}
        hint="Capabilities above the role, or above your own access, are refused or dropped by the server."
        onChange={(e) => custom({ role: e.target.value as PolicyForm["role"] })}
      />
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm">
          Capabilities ({form.capabilities.length} selected)
        </summary>
        <div className="max-h-72 space-y-3 overflow-y-auto border-t border-border px-3 py-2">
          {GROUPS.map(({ resource, capabilities }) => (
            <fieldset key={resource} className="space-y-1">
              <legend className="tila-label">{resource}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {capabilities.map((cap) => (
                  <CheckboxField
                    key={cap}
                    label={<span className="font-mono text-xs">{cap}</span>}
                    checked={form.capabilities.includes(cap)}
                    disabled={disabled}
                    onChange={(checked) =>
                      custom({
                        capabilities: DELEGABLE.filter((c: Capability) =>
                          c === cap ? checked : form.capabilities.includes(c),
                        ),
                      })
                    }
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </details>
      <TextAreaField
        label="Limit to task types"
        rows={2}
        className="font-mono text-xs"
        spellCheck={false}
        value={form.task_types}
        disabled={disabled}
        hint="Optional. One task type per line; empty allows every type."
        onChange={(e) => onChange({ ...form, task_types: e.target.value })}
      />
      {form.records_split ? (
        <TextAreaField
          label="Limit to records"
          rows={Math.max(
            2,
            splitRecordLines(form.records_split).split("\n").length,
          )}
          className="font-mono text-xs"
          spellCheck={false}
          value={splitRecordLines(form.records_split)}
          disabled
          readOnly
          hint="This policy limits record reads and writes separately. It is kept exactly as it is when you save; change it with the CLI."
        />
      ) : (
        <TextAreaField
          label="Limit to records"
          rows={2}
          className="font-mono text-xs"
          spellCheck={false}
          value={form.records}
          disabled={disabled}
          hint="Optional. One per line: a record type, or type/key-prefix. Empty allows every record."
          onChange={(e) => onChange({ ...form, records: e.target.value })}
        />
      )}
      {problem && (
        <p role="alert" className="text-sm text-status-red">
          {problem}
        </p>
      )}
    </div>
  );
}
