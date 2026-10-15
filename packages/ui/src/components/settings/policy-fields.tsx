import { CheckboxField } from "@/components/definitions/controls";
import { uniqueLines } from "@/components/settings/settings-ui";
import { SelectField, TextAreaField } from "@/components/ui/form-fields";
import {
  describeRules,
  parseRules,
  renderRules,
  ruleLines,
} from "@/lib/record-rules";
import {
  CAPABILITIES,
  CREDENTIAL_PRESETS,
  type Capability,
  type CredentialPolicy,
  CredentialPolicySchema,
  ROOT_CAPABILITIES,
  type RecordRestrictionRule,
  RecordRestrictionRuleSchema,
  effectiveCredentialPolicy,
  hasRecordRestrictions,
  recordRulesForSide,
} from "@tila/schemas";
import { z } from "zod";

const RuleList = z.array(RecordRestrictionRuleSchema);

/**
 * Record rules that limit reading and writing separately, as saved by a form
 * that could only carry them. Kept so a draft from that form still opens.
 */
const SplitRecords = z.object({
  records_read: RuleList.optional(),
  records_write: RuleList.optional(),
});
type SplitRecords = z.infer<typeof SplitRecords>;

/** The namespace restrictions a policy held when the form was opened. */
const StoredRestrictions = z.object({
  task_types: z.array(z.string()).optional(),
  records: RuleList.optional(),
  records_read: RuleList.optional(),
  records_write: RuleList.optional(),
});
type StoredRestrictions = z.infer<typeof StoredRestrictions>;

/**
 * How record access is limited:
 * - `all`: no record limit; the capabilities decide.
 * - `same`: one list for reading and writing (the legacy `records` rule).
 * - `separate`: `records_read` and `records_write`; a side with no lines
 *   allows no record.
 * The three are exclusive, so a saved policy never carries two of them.
 */
export const RECORD_MODES = ["all", "same", "separate"] as const;
export type RecordsMode = (typeof RECORD_MODES)[number];

/**
 * A credential policy as the forms edit it: a preset or a custom role and
 * capability list, plus optional namespace restrictions written one per line.
 * Over-broad policies are left for the server to refuse with its own message.
 *
 * Each record mode keeps its own text, so switching modes never discards what
 * was typed. `stored` holds the restrictions the policy was opened with: a
 * list whose text has not been edited is written back as it was stored, which
 * keeps an explicit empty list (deny) and a rule with no key prefixes from
 * turning into "no limit". Drafts from older forms lack `records_mode` and
 * the per-side texts; `resolve` derives them.
 */
export const PolicyForm = z.object({
  preset: z.string(),
  role: z.enum(["viewer", "participant", "maintainer", "owner"]),
  capabilities: z.array(z.string()),
  task_types: z.string(),
  /** The one record list of the `same` mode. */
  records: z.string(),
  records_mode: z.enum(RECORD_MODES).optional(),
  records_read: z.string().optional(),
  records_write: z.string().optional(),
  stored: StoredRestrictions.optional(),
  /** Split rules carried by a draft from the form that could not edit them. */
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
const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

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
  const restrictions = policy.restrictions;
  const { task_types, records, records_read, records_write } =
    restrictions ?? {};
  const stored: StoredRestrictions = {
    ...(task_types === undefined ? {} : { task_types }),
    ...(records === undefined ? {} : { records }),
    ...(records_read === undefined ? {} : { records_read }),
    ...(records_write === undefined ? {} : { records_write }),
  };
  const mode: RecordsMode =
    records_read !== undefined || records_write !== undefined
      ? "separate"
      : records !== undefined
        ? "same"
        : "all";
  const preset =
    !restrictions &&
    PRESETS.find(
      (name) =>
        CREDENTIAL_PRESETS[name].role === policy.role &&
        sameSet(CREDENTIAL_PRESETS[name].capabilities, policy.capabilities),
    );
  return {
    preset: preset || CUSTOM,
    role: policy.role,
    capabilities: [...policy.capabilities],
    task_types: (task_types ?? []).join("\n"),
    records: renderRules(records),
    records_mode: mode,
    records_read: renderRules(records_read),
    records_write: renderRules(records_write),
    ...(Object.keys(stored).length === 0 ? {} : { stored }),
  };
}

/** A form with every record field filled in, whatever draft it came from. */
function resolve(form: PolicyForm) {
  const split = form.records_split;
  const stored: StoredRestrictions = form.stored ?? { ...split };
  const mode: RecordsMode =
    form.records_mode ??
    (split ? "separate" : form.records.trim() ? "same" : "all");
  return {
    mode,
    same: form.records,
    read: form.records_read ?? renderRules(split?.records_read),
    write: form.records_write ?? renderRules(split?.records_write),
    stored,
  };
}

/** The form with `change` applied to its record fields, in the current shape. */
function withRecords(
  form: PolicyForm,
  change: Partial<
    Pick<
      PolicyForm,
      "records" | "records_mode" | "records_read" | "records_write"
    >
  >,
): PolicyForm {
  const current = resolve(form);
  const { records_split: _carried, ...rest } = form;
  return {
    ...rest,
    records: current.same,
    records_mode: current.mode,
    records_read: current.read,
    records_write: current.write,
    stored: current.stored,
    ...change,
  };
}

/**
 * Change how records are limited. Nothing typed is lost, and the only text
 * carried over is text that already meant the same thing: one list becomes
 * both sides of a separate limit, and two identical sides become one list.
 */
function withMode(form: PolicyForm, mode: RecordsMode): PolicyForm {
  const { same, read, write } = resolve(form);
  let next = { records: same, records_read: read, records_write: write };
  if (mode === "separate" && !read.trim() && !write.trim() && same.trim())
    next = { ...next, records_read: same, records_write: same };
  if (mode === "same" && !same.trim() && read.trim() && read === write)
    next = { ...next, records: read };
  return withRecords(form, { ...next, records_mode: mode });
}

type SideResult = { rules: RecordRestrictionRule[] | undefined; problem: null };

/**
 * The rules one record list holds. Text that still reads as the stored list
 * gives the stored list back unchanged, so nothing the lines cannot show is
 * lost; any other text is parsed.
 */
function sideRules(
  text: string,
  stored: RecordRestrictionRule[] | undefined,
  label: string,
): SideResult | { problem: string } {
  const lines = ruleLines(text);
  if (stored !== undefined) {
    if (sameLines(lines, ruleLines(renderRules(stored))))
      return { rules: stored, problem: null };
  } else if (lines.length === 0) return { rules: undefined, problem: null };
  const parsed = parseRules(text, label);
  return parsed.problem === null
    ? { rules: parsed.rules, problem: null }
    : { problem: parsed.problem };
}

const READ_LABEL = "Records it may read";
const WRITE_LABEL = "Records it may write";
const SAME_LABEL = "Limit to records";
const FIELD_LABELS: Record<string, string> = {
  task_types: "Limit to task types",
  records: SAME_LABEL,
  records_read: READ_LABEL,
  records_write: WRITE_LABEL,
};

/** The policy a form describes; `problem` explains why it is invalid. */
export function formToPolicy(
  form: PolicyForm,
): { policy: CredentialPolicy; problem: null } | { problem: string } {
  // A draft from the form that could only carry split rules has them in
  // `records_split`; a record list next to them is refused, never merged.
  if (
    form.records_split &&
    form.records_mode === undefined &&
    uniqueLines(form.records).length > 0
  )
    return {
      problem:
        "records: this policy limits record reads and writes separately; clear the record list",
    };
  const current = resolve(form);

  // An unedited list keeps what was stored, including an explicit empty list;
  // edited task types fall back to "no limit" when nothing is left.
  const taskLines = uniqueLines(form.task_types);
  const task_types =
    current.stored.task_types !== undefined &&
    sameLines(taskLines, current.stored.task_types)
      ? current.stored.task_types
      : taskLines.length
        ? taskLines
        : undefined;

  let records: RecordRestrictionRule[] | undefined;
  let records_read: RecordRestrictionRule[] | undefined;
  let records_write: RecordRestrictionRule[] | undefined;
  if (current.mode === "same") {
    const same = sideRules(current.same, current.stored.records, SAME_LABEL);
    if (same.problem !== null) return { problem: same.problem };
    // An empty single list allows no record; "no limit" is its own mode.
    records = same.rules ?? [];
  } else if (current.mode === "separate") {
    const read = sideRules(
      current.read,
      current.stored.records_read,
      READ_LABEL,
    );
    if (read.problem !== null) return { problem: read.problem };
    const write = sideRules(
      current.write,
      current.stored.records_write,
      WRITE_LABEL,
    );
    if (write.problem !== null) return { problem: write.problem };
    records_read = read.rules;
    records_write = write.rules;
    // Both sides absent would read as "no limit". A side that was left out of
    // a stored policy stays out (it denies), but a policy with neither side
    // writes both as the explicit denies they are.
    if (records_read === undefined && records_write === undefined) {
      records_read = [];
      records_write = [];
    }
  }

  const restrictions = {
    ...(task_types === undefined ? {} : { task_types }),
    ...(records === undefined ? {} : { records }),
    ...(records_read === undefined ? {} : { records_read }),
    ...(records_write === undefined ? {} : { records_write }),
  };
  const parsed = CredentialPolicySchema.safeParse({
    role: form.role,
    capabilities: form.capabilities,
    ...(Object.keys(restrictions).length ? { restrictions } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] === "restrictions" ? issue.path[1] : undefined;
    const label =
      typeof field === "string"
        ? FIELD_LABELS[field]
        : issue?.path.join(".") || "policy";
    return { problem: `${label ?? "policy"}: ${issue?.message ?? "invalid"}` };
  }
  return { policy: parsed.data, problem: null };
}

/**
 * What the policy lets its holder read and write, side by side. A side whose
 * capability is not granted (or is above the role ceiling) reads `none`,
 * whatever its rules say.
 */
export function recordAccess(policy: CredentialPolicy): {
  read: string;
  write: string;
} {
  const granted = effectiveCredentialPolicy(policy, policy.role).capabilities;
  const side = (name: "read" | "write", capability: Capability) =>
    granted.includes(capability)
      ? describeRules(recordRulesForSide(policy.restrictions, name))
      : `none (no ${capability})`;
  return {
    read: side("read", "records:read"),
    write: side("write", "records:write"),
  };
}

/** One-line summary: "participant · 21 capabilities · tasks: bug". */
export function policySummary(policy: CredentialPolicy): string {
  const parts = [
    policy.role,
    `${policy.capabilities.length} ${policy.capabilities.length === 1 ? "capability" : "capabilities"}`,
  ];
  if (policy.restrictions?.task_types)
    parts.push(
      `tasks: ${policy.restrictions.task_types.length ? policy.restrictions.task_types.join(", ") : "none"}`,
    );
  // Every record limit is stated for both sides. A side the rules do not list
  // denies every record, and a legacy list applies to both.
  if (hasRecordRestrictions(policy.restrictions)) {
    const access = recordAccess(policy);
    parts.push(
      `records read: ${access.read}`,
      `records write: ${access.write}`,
    );
  }
  return parts.join(" · ");
}

const MODE_OPTIONS: Array<{ value: RecordsMode; label: string }> = [
  { value: "all", label: "Every record the capabilities allow" },
  { value: "same", label: "Limit reads and writes to the same records" },
  { value: "separate", label: "Limit reads and writes separately" },
];

const MODE_HINT: Record<RecordsMode, string> = {
  all: "No record limit: the capabilities alone decide.",
  same: "One list limits reading and writing alike. An empty list allows no record.",
  separate:
    "Each side has its own list. A side with no lines allows no record on that side.",
};

const LIST_HINT =
  "One per line: a record type, or type/key-prefix (that key and the keys below it).";

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
  const current = resolve(form);
  const built = formToPolicy(form);
  const access = built.problem === null ? recordAccess(built.policy) : null;
  const rows = (text: string) => Math.max(2, ruleLines(text).length + 1);
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
          else {
            // Only the role and capabilities come from the preset: every limit
            // on tasks and records stays as it is.
            const filled = presetForm(value as Preset);
            onChange({
              ...form,
              preset: filled.preset,
              role: filled.role,
              capabilities: filled.capabilities,
            });
          }
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
        hint={
          current.stored.task_types?.length === 0 && !form.task_types.trim()
            ? "This policy allows no task types. Add one per line to allow them."
            : "Optional. One task type per line; empty allows every type."
        }
        onChange={(e) => onChange({ ...form, task_types: e.target.value })}
      />
      <SelectField
        label="Record access"
        value={current.mode}
        disabled={disabled}
        options={MODE_OPTIONS}
        hint={MODE_HINT[current.mode]}
        onChange={(e) =>
          onChange(withMode(form, e.target.value as RecordsMode))
        }
      />
      {current.mode === "same" && (
        <TextAreaField
          label={SAME_LABEL}
          rows={rows(current.same)}
          className="font-mono text-xs"
          spellCheck={false}
          value={current.same}
          disabled={disabled}
          hint={LIST_HINT}
          onChange={(e) =>
            onChange(withRecords(form, { records: e.target.value }))
          }
        />
      )}
      {current.mode === "separate" && (
        <>
          <TextAreaField
            label={READ_LABEL}
            rows={rows(current.read)}
            className="font-mono text-xs"
            spellCheck={false}
            value={current.read}
            disabled={disabled}
            hint={`${LIST_HINT} Empty allows no read.`}
            onChange={(e) =>
              onChange(withRecords(form, { records_read: e.target.value }))
            }
          />
          <TextAreaField
            label={WRITE_LABEL}
            rows={rows(current.write)}
            className="font-mono text-xs"
            spellCheck={false}
            value={current.write}
            disabled={disabled}
            hint={`${LIST_HINT} Empty allows no write. A key it may write but not read returns a receipt, never the record.`}
            onChange={(e) =>
              onChange(withRecords(form, { records_write: e.target.value }))
            }
          />
        </>
      )}
      {access && (
        <output
          aria-label="Effective record access"
          className="block text-xs text-muted-foreground"
        >
          Reads: {access.read} · Writes: {access.write}
        </output>
      )}
      {problem && (
        <p role="alert" className="text-sm text-status-red">
          {problem}
        </p>
      )}
    </div>
  );
}
