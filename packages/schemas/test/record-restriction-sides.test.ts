import { describe, expect, it } from "vitest";
import {
  type CredentialPolicy,
  CredentialPolicySchema,
  type NamespaceRestrictions,
  type RecordRestrictionRule,
  canEchoStoredRecord,
  hasNamespaceRestrictions,
  hasRecordRestrictions,
  hasSplitRecordRestrictions,
  intersectCredentialPolicies,
  isReadMethod,
  permitsRecord,
  permitsRecordRead,
  permitsRecordSide,
  permitsRecordWrite,
  policyContains,
  recordRulesForSide,
} from "../src/capability";

type Rules = RecordRestrictionRule[];

const policy = (
  restrictions?: NamespaceRestrictions,
  capabilities: CredentialPolicy["capabilities"] = [
    "records:read",
    "records:write",
  ],
): CredentialPolicy => ({
  role: "participant",
  capabilities,
  ...(restrictions === undefined ? {} : { restrictions }),
});

// ---------------------------------------------------------------------------
// The previous single-list implementation, kept verbatim as the reference a
// legacy `records` policy must still match.
// ---------------------------------------------------------------------------

function referencePermits(
  records: Rules | undefined,
  type: string,
  key: string,
): boolean {
  return (
    records === undefined ||
    records.some(
      (rule) =>
        rule.type === type &&
        (rule.key_prefixes === undefined ||
          rule.key_prefixes.some(
            (prefix) => key === prefix || key.startsWith(`${prefix}/`),
          )),
    )
  );
}
function referenceContains(
  parent: Rules | undefined,
  child: Rules | undefined,
): boolean {
  if (parent === undefined) return true;
  if (child === undefined) return false;
  for (const rule of child) {
    if (rule.key_prefixes === undefined) {
      if (
        !parent.some(
          (allowed) =>
            allowed.type === rule.type && allowed.key_prefixes === undefined,
        )
      )
        return false;
    } else if (
      rule.key_prefixes.some(
        (prefix) => !referencePermits(parent, rule.type, prefix),
      )
    )
      return false;
  }
  return true;
}
function referenceIntersect(
  a: Rules | undefined,
  b: Rules | undefined,
): Rules | undefined {
  return a === undefined
    ? b
    : b === undefined
      ? a
      : a.flatMap((left) =>
          b
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
}

// ---------------------------------------------------------------------------
// A small deterministic universe of rule lists and records.
// ---------------------------------------------------------------------------

const PREFIX_CHOICES: (string[] | undefined)[] = [
  undefined,
  [],
  ["x"],
  ["x/y"],
  ["x", "z"],
];
const RULES: RecordRestrictionRule[] = ["a", "b"].flatMap((type) =>
  PREFIX_CHOICES.map((key_prefixes) => ({
    type,
    ...(key_prefixes === undefined ? {} : { key_prefixes }),
  })),
);
const RULE_LISTS: Rules[] = [
  [],
  ...RULES.map((rule) => [rule]),
  ...RULES.flatMap((first) => RULES.map((second) => [first, second])),
];
const PROBES: [string, string][] = [
  ["a", "x"],
  ["a", "x/y"],
  ["a", "x/y/w"],
  ["a", "xy"],
  ["a", "z"],
  ["a", "q"],
  ["b", "x"],
  ["b", "x/y"],
  ["c", "x"],
];

/** Mulberry32, so the sampled shapes are the same on every run. */
function prng(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampledRestrictions(count: number, seed: number) {
  const next = prng(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)];
  const out: NamespaceRestrictions[] = [{}];
  while (out.length < count) {
    const shape = Math.floor(next() * 3);
    if (shape === 0) out.push({ records: pick(RULE_LISTS) });
    else if (shape === 1)
      out.push({
        records_read: pick(RULE_LISTS),
        records_write: pick(RULE_LISTS),
      });
    else if (next() < 0.5) out.push({ records_read: pick(RULE_LISTS) });
    else out.push({ records_write: pick(RULE_LISTS) });
  }
  return out;
}
const SHAPES = sampledRestrictions(36, 530);

describe("restrictions schema", () => {
  it("parses every legacy form unchanged", () => {
    for (const restrictions of [
      { records: [{ type: "config" }] },
      { records: [{ type: "config", key_prefixes: ["team/a"] }] },
      { records: [] },
      { records: [{ type: "config", key_prefixes: [] }] },
      { task_types: ["task"], records: [{ type: "config" }] },
      { task_types: [] },
      {},
    ]) {
      const parsed = CredentialPolicySchema.parse({
        role: "participant",
        capabilities: [],
        restrictions,
      });
      expect(parsed.restrictions).toEqual(restrictions);
    }
  });

  it("parses the split form, with either side or both", () => {
    for (const restrictions of [
      { records_read: [{ type: "answer" }] },
      { records_write: [{ type: "question", key_prefixes: ["q1"] }] },
      { records_read: [], records_write: [] },
      {
        task_types: ["task"],
        records_read: [{ type: "answer" }],
        records_write: [{ type: "question" }],
      },
    ])
      expect(
        CredentialPolicySchema.safeParse({
          role: "participant",
          capabilities: [],
          restrictions,
        }).success,
      ).toBe(true);
  });

  it("rejects mixing the legacy and split forms and unknown keys", () => {
    for (const restrictions of [
      { records: [], records_read: [] },
      { records: [{ type: "a" }], records_write: [{ type: "a" }] },
      { records: [], records_read: [], records_write: [] },
      { records_all: [] },
      { records_read: [{ type: "a", write: true }] },
    ])
      expect(
        CredentialPolicySchema.safeParse({
          role: "participant",
          capabilities: [],
          restrictions,
        }).success,
        JSON.stringify(restrictions),
      ).toBe(false);
  });
});

describe("side predicates", () => {
  it("legacy `records` governs both sides exactly as before", () => {
    for (const records of RULE_LISTS) {
      const restrictions = { records };
      for (const [type, key] of PROBES) {
        const expected = referencePermits(records, type, key);
        expect(permitsRecordRead(restrictions, type, key)).toBe(expected);
        expect(permitsRecordWrite(restrictions, type, key)).toBe(expected);
        expect(permitsRecord(restrictions, type, key)).toBe(expected);
      }
    }
  });

  it("an unrestricted policy admits both sides", () => {
    for (const restrictions of [undefined, {}, { task_types: ["task"] }])
      for (const [type, key] of PROBES) {
        expect(permitsRecordRead(restrictions, type, key)).toBe(true);
        expect(permitsRecordWrite(restrictions, type, key)).toBe(true);
      }
  });

  it("denies the side a split policy leaves out", () => {
    const writeOnly = { records_write: [{ type: "question" }] };
    expect(permitsRecordWrite(writeOnly, "question", "q1")).toBe(true);
    expect(permitsRecordRead(writeOnly, "question", "q1")).toBe(false);
    expect(permitsRecordRead(writeOnly, "answer", "a1")).toBe(false);
    expect(recordRulesForSide(writeOnly, "read")).toEqual([]);

    const readOnly = { records_read: [{ type: "answer" }] };
    expect(permitsRecordRead(readOnly, "answer", "a1")).toBe(true);
    expect(permitsRecordWrite(readOnly, "answer", "a1")).toBe(false);
  });

  it("an empty list denies every record on its side", () => {
    const restrictions = {
      records_read: [] as Rules,
      records_write: [{ type: "question" }],
    };
    expect(permitsRecordRead(restrictions, "question", "q1")).toBe(false);
    expect(permitsRecordWrite(restrictions, "question", "q1")).toBe(true);
    expect(permitsRecordWrite({ records_write: [] }, "question", "q1")).toBe(
      false,
    );
  });

  it("the issue's example holds per record", () => {
    const restrictions = {
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "question", key_prefixes: ["q1"] }],
    };
    expect(permitsRecordRead(restrictions, "answer", "a1/x")).toBe(true);
    expect(permitsRecordWrite(restrictions, "answer", "a1/x")).toBe(false);
    expect(permitsRecordRead(restrictions, "question", "q1/x")).toBe(false);
    expect(permitsRecordWrite(restrictions, "question", "q1/x")).toBe(true);
    expect(permitsRecordRead(restrictions, "answer", "a10")).toBe(false);
    expect(permitsRecord(restrictions, "answer", "a1/x")).toBe(false);
  });

  it("a hand-built policy mixing both forms denies everything", () => {
    const mixed = {
      records: [{ type: "a" }],
      records_read: [{ type: "a" }],
    } as NamespaceRestrictions;
    expect(permitsRecordRead(mixed, "a", "x")).toBe(false);
    expect(permitsRecordWrite(mixed, "a", "x")).toBe(false);
  });

  it("every restriction field marks the policy restricted", () => {
    for (const restrictions of [
      { task_types: [] },
      { records: [] },
      { records_read: [] },
      { records_write: [] },
    ])
      expect(hasNamespaceRestrictions(policy(restrictions))).toBe(true);
    expect(hasNamespaceRestrictions(policy({}))).toBe(false);
    expect(hasNamespaceRestrictions(policy())).toBe(false);
    expect(hasRecordRestrictions({ records_write: [] })).toBe(true);
    expect(hasRecordRestrictions({ task_types: [] })).toBe(false);
    expect(hasSplitRecordRestrictions({ records_read: [] })).toBe(true);
    expect(hasSplitRecordRestrictions({ records: [] })).toBe(false);
  });

  it("permitsRecordSide agrees with the named predicates", () => {
    for (const restrictions of SHAPES)
      for (const [type, key] of PROBES) {
        expect(permitsRecordSide(restrictions, "read", type, key)).toBe(
          permitsRecordRead(restrictions, type, key),
        );
        expect(permitsRecordSide(restrictions, "write", type, key)).toBe(
          permitsRecordWrite(restrictions, type, key),
        );
      }
  });
});

describe("canEchoStoredRecord", () => {
  const split = {
    records_read: [{ type: "answer" }],
    records_write: [{ type: "question" }],
  };
  it("keeps the full response for every policy that is not split", () => {
    expect(canEchoStoredRecord(policy(), "question", "q")).toBe(true);
    expect(canEchoStoredRecord(policy({}), "question", "q")).toBe(true);
    expect(
      canEchoStoredRecord(
        policy({ records: [{ type: "question" }] }),
        "x",
        "y",
      ),
    ).toBe(true);
    // A legacy policy keeps its response even without the read capability.
    expect(
      canEchoStoredRecord(
        policy({ records: [{ type: "question" }] }, ["records:write"]),
        "question",
        "q",
      ),
    ).toBe(true);
  });
  it("needs the read side and the read capability for a split policy", () => {
    expect(canEchoStoredRecord(policy(split), "answer", "a")).toBe(true);
    expect(canEchoStoredRecord(policy(split), "question", "q")).toBe(false);
    expect(
      canEchoStoredRecord(policy(split, ["records:write"]), "answer", "a"),
    ).toBe(false);
    expect(
      canEchoStoredRecord(
        policy({ records_write: [{ type: "question" }] }),
        "question",
        "q",
      ),
    ).toBe(false);
  });
});

describe("containment is per side", () => {
  const widerWrite = policy({
    records_read: [{ type: "a", key_prefixes: ["x"] }],
    records_write: [{ type: "a" }],
  });
  const widerRead = policy({
    records_read: [{ type: "a" }],
    records_write: [{ type: "a", key_prefixes: ["x"] }],
  });

  it("does not let a child trade one side for the other", () => {
    expect(policyContains(widerWrite, widerRead)).toBe(false);
    expect(policyContains(widerRead, widerWrite)).toBe(false);
    expect(policyContains(widerWrite, widerWrite)).toBe(true);
  });

  it("contains a one-sided child, which denies the missing side", () => {
    const parent = policy({ records: [{ type: "a" }] });
    expect(
      policyContains(parent, policy({ records_read: [{ type: "a" }] })),
    ).toBe(true);
    expect(
      policyContains(parent, policy({ records_write: [{ type: "a" }] })),
    ).toBe(true);
  });

  it("refuses a legacy child of a one-sided parent", () => {
    expect(
      policyContains(
        policy({ records_write: [{ type: "a" }] }),
        policy({ records: [{ type: "a" }] }),
      ),
    ).toBe(false);
  });

  it("refuses an unrestricted child of any restricted side", () => {
    for (const parent of [
      { records: [] },
      { records_read: [] },
      { records_write: [{ type: "a" }] },
    ])
      expect(policyContains(policy(parent), policy())).toBe(false);
  });

  it("matches the previous containment for every legacy pair", () => {
    for (const parent of RULE_LISTS.concat([undefined as unknown as Rules]))
      for (const child of RULE_LISTS.slice(0, 40).concat([
        undefined as unknown as Rules,
      ])) {
        const p = parent === undefined ? undefined : { records: parent };
        const c = child === undefined ? undefined : { records: child };
        expect(policyContains(policy(p), policy(c))).toBe(
          referenceContains(parent, child),
        );
      }
  });

  it("is sound: a contained child admits no record its parent refuses", () => {
    let contained = 0;
    for (const parent of SHAPES)
      for (const child of SHAPES) {
        if (!policyContains(policy(parent), policy(child))) continue;
        contained++;
        for (const side of ["read", "write"] as const)
          for (const [type, key] of PROBES)
            if (permitsRecordSide(child, side, type, key))
              expect(
                permitsRecordSide(parent, side, type, key),
                `${side} ${type}/${key}: ${JSON.stringify(parent)} ⊇ ${JSON.stringify(child)}`,
              ).toBe(true);
      }
    // The universe must actually contain containing pairs for this to mean anything.
    expect(contained).toBeGreaterThan(200);
  });
});

describe("narrowing is per side", () => {
  it("is exactly the intersection of what each side admits", () => {
    for (const a of SHAPES)
      for (const b of SHAPES.slice(0, 20)) {
        const narrowed = intersectCredentialPolicies(policy(a), policy(b));
        for (const side of ["read", "write"] as const)
          for (const [type, key] of PROBES)
            expect(
              permitsRecordSide(narrowed.restrictions, side, type, key),
              `${side} ${type}/${key}: ${JSON.stringify(a)} ∩ ${JSON.stringify(b)}`,
            ).toBe(
              permitsRecordSide(a, side, type, key) &&
                permitsRecordSide(b, side, type, key),
            );
      }
  });

  it("never exceeds either input", () => {
    for (const a of SHAPES)
      for (const b of SHAPES.slice(0, 20)) {
        const narrowed = intersectCredentialPolicies(policy(a), policy(b));
        expect(policyContains(policy(a), narrowed)).toBe(true);
        expect(policyContains(policy(b), narrowed)).toBe(true);
      }
  });

  it("emits the legacy single list for legacy inputs, byte for byte", () => {
    for (const a of RULE_LISTS.slice(0, 30))
      for (const b of RULE_LISTS.slice(0, 30)) {
        const narrowed = intersectCredentialPolicies(
          policy({ task_types: ["t"], records: a }),
          policy({ task_types: ["t", "u"], records: b }),
        );
        expect(JSON.stringify(narrowed.restrictions)).toBe(
          JSON.stringify({
            task_types: ["t"],
            records: referenceIntersect(a, b),
          }),
        );
      }
    const noRecords = intersectCredentialPolicies(policy({}), policy({}));
    expect(noRecords.restrictions).toEqual({});
    const one = intersectCredentialPolicies(
      policy({ records: [{ type: "a" }] }),
      policy(),
    );
    expect(one.restrictions).toEqual({ records: [{ type: "a" }] });
  });

  it("keeps the sides apart once either input is split", () => {
    const narrowed = intersectCredentialPolicies(
      policy({
        records_read: [{ type: "answer" }],
        records_write: [{ type: "question" }],
      }),
      policy({ records: [{ type: "answer" }, { type: "question" }] }),
    );
    expect(narrowed.restrictions).toEqual({
      records_read: [{ type: "answer" }],
      records_write: [{ type: "question" }],
    });
  });

  it("never turns a denied side into an admitted one", () => {
    const narrowed = intersectCredentialPolicies(
      policy({ records_write: [{ type: "question" }] }),
      policy(),
    );
    expect(permitsRecordRead(narrowed.restrictions, "question", "q")).toBe(
      false,
    );
    expect(permitsRecordWrite(narrowed.restrictions, "question", "q")).toBe(
      true,
    );
  });
});

describe("isReadMethod", () => {
  it("is GET and HEAD only", () => {
    expect(isReadMethod("GET")).toBe(true);
    expect(isReadMethod("HEAD")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get"])
      expect(isReadMethod(method), method).toBe(false);
  });
});
