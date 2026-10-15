import {
  RecordKeySchema,
  type RecordRestrictionRule,
  RecordTypeSchema,
} from "@tila/schemas";

/**
 * Record rules as the policy form edits them: one per line, `type` for every
 * key of a type, `type/key-prefix` for keys at or below a prefix, and
 * `type (no keys)` for a rule that admits nothing. Every shape the schema
 * accepts has a line, so showing rules never hides one and editing never has to
 * guess what a missing line meant.
 */
const NO_KEYS = " (no keys)";

/** The lines for a rule list; an absent list and an empty one both have none. */
export function renderRules(
  rules: readonly RecordRestrictionRule[] | undefined,
): string {
  return (rules ?? [])
    .flatMap((rule) =>
      rule.key_prefixes === undefined
        ? [rule.type]
        : rule.key_prefixes.length === 0
          ? [`${rule.type}${NO_KEYS}`]
          : rule.key_prefixes.map((prefix) => `${rule.type}/${prefix}`),
    )
    .join("\n");
}

/** Trimmed non-blank lines in order, duplicates kept. */
export function ruleLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export type ParsedRules =
  | { rules: RecordRestrictionRule[]; problem: null }
  | { problem: string };

/**
 * Rules written as lines. An empty text is an empty list, which allows no
 * record: callers that mean "no limit" must not write the field at all. A type
 * listed whole absorbs its prefixes (it already admits them), and a type with
 * only `(no keys)` lines keeps an empty prefix list.
 */
export function parseRules(text: string, label: string): ParsedRules {
  const byType = new Map<
    string,
    { whole: boolean; prefixes: string[]; none: boolean }
  >();
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const fail = (message: string): { problem: string } => ({
      problem: `${label}, line ${index + 1} (${line}): ${message}`,
    });
    const none = line.endsWith(NO_KEYS);
    const body = none ? line.slice(0, -NO_KEYS.length) : line;
    const slash = none ? -1 : body.indexOf("/");
    const type = slash < 0 ? body : body.slice(0, slash);
    const prefix = slash < 0 ? null : body.slice(slash + 1);
    const typeResult = RecordTypeSchema.safeParse(type);
    if (!typeResult.success)
      return fail(typeResult.error.issues[0]?.message ?? "Invalid record type");
    if (prefix !== null) {
      if (prefix === "")
        return fail(
          `the key prefix after "/" is empty. Write "${type}" to cover every key of the type.`,
        );
      const keyResult = RecordKeySchema.safeParse(prefix);
      if (!keyResult.success)
        return fail(keyResult.error.issues[0]?.message ?? "Invalid key prefix");
    }
    const rule = byType.get(type) ?? {
      whole: false,
      prefixes: [],
      none: false,
    };
    if (none) rule.none = true;
    else if (prefix === null) rule.whole = true;
    else rule.prefixes.push(prefix);
    byType.set(type, rule);
  }
  const rules = [...byType].map(([type, rule]): RecordRestrictionRule => {
    if (rule.whole) return { type };
    return { type, key_prefixes: rule.prefixes };
  });
  return { rules, problem: null };
}

/**
 * What a rule list admits, for people: `every record` when unrestricted,
 * `none` when nothing is admitted, otherwise the types and prefixes.
 */
export function describeRules(
  rules: readonly RecordRestrictionRule[] | undefined,
): string {
  if (rules === undefined) return "every record";
  const names = rules.flatMap((rule) =>
    rule.key_prefixes === undefined
      ? [rule.type]
      : rule.key_prefixes.map((prefix) => `${rule.type}/${prefix}`),
  );
  return names.length === 0 ? "none" : names.join(", ");
}
