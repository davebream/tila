/**
 * Settings writes name the revision the caller reviewed. `--latest` is the
 * explicit opt-out: it reads the current revision and writes against it, so a
 * concurrent change is overwritten without review.
 */
export const revisionArgs = {
  "expected-revision": {
    type: "string" as const,
    description: "Revision you reviewed (from inspect); stale values fail",
  },
  latest: {
    type: "boolean" as const,
    default: false,
    description:
      "Write against the current revision without reviewing it (overrides concurrent changes)",
  },
};

export async function expectedRevision(
  args: { "expected-revision"?: string; latest?: boolean },
  current: () => Promise<number>,
): Promise<number> {
  const raw = args["expected-revision"];
  if (raw !== undefined && args.latest)
    throw new Error("Use either --expected-revision or --latest, not both");
  if (raw !== undefined) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1)
      throw new Error("--expected-revision must be a positive integer");
    return value;
  }
  if (args.latest) return current();
  throw new Error(
    "Pass --expected-revision <n> from inspect, or --latest to write without review",
  );
}

/** Parse an optional integer flag; undefined when absent. */
export function integerFlag(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new Error(`--${name} must be an integer`);
  return parsed;
}

export function principalList(value: string | undefined) {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
