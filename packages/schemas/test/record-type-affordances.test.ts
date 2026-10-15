import { describe, expect, it } from "vitest";
import {
  type NamespaceRestrictions,
  type RecordAccessSide,
  permitsAnyRecordSide,
  permitsRecordSide,
  permitsRecordTypeSide,
} from "../src/capability";

const SIDES: RecordAccessSide[] = ["read", "write"];

/** Every shape the type-level predicates must agree with the per-key one on. */
const CASES: Array<[string, NamespaceRestrictions | undefined]> = [
  ["unrestricted", undefined],
  ["task limits only", { task_types: ["bug"] }],
  ["legacy whole type", { records: [{ type: "config" }] }],
  ["legacy deny all", { records: [] }],
  ["legacy prefixes", { records: [{ type: "config", key_prefixes: ["a/b"] }] }],
  [
    "legacy empty prefixes",
    { records: [{ type: "config", key_prefixes: [] }] },
  ],
  [
    "legacy empty prefixes next to a whole type",
    { records: [{ type: "config", key_prefixes: [] }, { type: "flag" }] },
  ],
  [
    "split both sides",
    {
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "question", key_prefixes: ["q1", "q2/x"] }],
    },
  ],
  ["split read only", { records_read: [{ type: "answer" }] }],
  ["split write only", { records_write: [{ type: "question" }] }],
  ["split empty read", { records_read: [], records_write: [{ type: "q" }] }],
  [
    "split empty prefixes",
    {
      records_read: [{ type: "answer", key_prefixes: [] }],
      records_write: [],
    },
  ],
  [
    "same type, different prefixes per side",
    {
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "answer", key_prefixes: ["a2"] }],
    },
  ],
];
const TYPES = ["config", "flag", "answer", "question", "q", "other"];

/** Keys that would reveal an admitted record of `type` under `restrictions`. */
function candidateKeys(
  restrictions: NamespaceRestrictions | undefined,
): string[] {
  const rules = [
    ...(restrictions?.records ?? []),
    ...(restrictions?.records_read ?? []),
    ...(restrictions?.records_write ?? []),
  ];
  return [
    "unrelated",
    ...rules.flatMap((rule) =>
      (rule.key_prefixes ?? []).flatMap((prefix) => [prefix, `${prefix}/x`]),
    ),
  ];
}

describe("permitsRecordTypeSide", () => {
  it.each(CASES)(
    "means some key of the type is permitted: %s",
    (_name, restrictions) => {
      for (const side of SIDES)
        for (const type of TYPES) {
          const some = candidateKeys(restrictions).some((key) =>
            permitsRecordSide(restrictions, side, type, key),
          );
          expect(
            permitsRecordTypeSide(restrictions, side, type),
            `${side} ${type}`,
          ).toBe(some);
        }
    },
  );

  it("admits a prefixed rule and refuses an empty prefix list", () => {
    const split: NamespaceRestrictions = {
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "answer", key_prefixes: [] }],
    };
    expect(permitsRecordTypeSide(split, "read", "answer")).toBe(true);
    expect(permitsRecordTypeSide(split, "write", "answer")).toBe(false);
  });

  it("denies the side a split policy leaves out, whatever the type", () => {
    const readOnly: NamespaceRestrictions = {
      records_read: [{ type: "answer" }],
    };
    expect(permitsRecordTypeSide(readOnly, "write", "answer")).toBe(false);
    expect(permitsRecordTypeSide(readOnly, "write", "anything")).toBe(false);
    expect(permitsRecordTypeSide(readOnly, "read", "anything")).toBe(false);
  });

  it("keeps a legacy list meaning both sides", () => {
    const legacy: NamespaceRestrictions = { records: [{ type: "config" }] };
    for (const side of SIDES) {
      expect(permitsRecordTypeSide(legacy, side, "config")).toBe(true);
      expect(permitsRecordTypeSide(legacy, side, "flag")).toBe(false);
    }
  });
});

describe("permitsAnyRecordSide", () => {
  it.each(CASES)(
    "agrees with the per-key predicate: %s",
    (_n, restrictions) => {
      for (const side of SIDES) {
        const some = TYPES.some((type) =>
          candidateKeys(restrictions).some((key) =>
            permitsRecordSide(restrictions, side, type, key),
          ),
        );
        expect(permitsAnyRecordSide(restrictions, side), side).toBe(some);
      }
    },
  );

  it("is false for a write-only credential's read side", () => {
    const writeOnly: NamespaceRestrictions = {
      records_write: [{ type: "question" }],
    };
    expect(permitsAnyRecordSide(writeOnly, "read")).toBe(false);
    expect(permitsAnyRecordSide(writeOnly, "write")).toBe(true);
  });
});
