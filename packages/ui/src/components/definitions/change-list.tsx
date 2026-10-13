import { Badge } from "@/components/ui/badge";
import type { SchemaChange } from "@tila/core";
import type { SchemaPreviewChange } from "@tila/schemas";
import type { ReactNode } from "react";

/** A server preview change, or a client diff change without data counts. */
type Change = SchemaPreviewChange | SchemaChange;

type Line = {
  key: string;
  title: ReactNode;
  effects: ReactNode[];
  destructive: boolean;
};

const n = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const code = (text: string) => <code className="font-mono">{text}</code>;

function isDestructive(change: Change): boolean {
  if (change.kind === "definition-changed") return change.destructive;
  return [
    "work-unit-removed",
    "field-removed",
    "field-required-added",
    "artifact-kind-removed",
    "record-type-removed",
    "record-field-removed",
    "record-field-required-added",
  ].includes(change.kind);
}

function legacyDefault(change: Change): ReactNode[] {
  if (
    (change.kind !== "field-added" && change.kind !== "record-field-added") ||
    change.declaration.default_for_legacy === undefined
  )
    return [];
  const rows =
    "legacyDefaultCount" in change ? change.legacyDefaultCount : undefined;
  const value = JSON.stringify(change.declaration.default_for_legacy);
  return [
    rows === undefined
      ? `Existing rows without it read ${value} lazily; stored rows are not rewritten.`
      : `${n(rows, "existing row")} without it will read ${value} lazily; stored rows are not rewritten.`,
  ];
}

function describe(change: Change): Omit<Line, "key" | "destructive"> {
  switch (change.kind) {
    case "work-unit-added":
      return { title: <>Add work type {code(change.unitType)}</>, effects: [] };
    case "work-unit-removed": {
      const archived =
        "archivedCount" in change && change.archivedCount
          ? ` and ${n(change.archivedCount, "archived task")}`
          : "";
      return {
        title: <>Retire work type {code(change.unitType)}</>,
        effects: [
          `${n(change.entityCount, "task")}${archived} stay readable as legacy data; nothing is deleted.`,
        ],
      };
    }
    case "field-added":
      return {
        title: (
          <>
            Add field {code(`${change.unitType}.${change.fieldName}`)} (
            {change.declaration.type})
          </>
        ),
        effects: legacyDefault(change),
      };
    case "field-removed":
      return {
        title: (
          <>Remove field {code(`${change.unitType}.${change.fieldName}`)}</>
        ),
        effects: [
          "entityCount" in change
            ? `${n(change.entityCount, "task")} hold a value. Values stay stored but are no longer declared.`
            : "Stored values stay but are no longer declared.",
        ],
      };
    case "field-required-added":
      return {
        title: (
          <>Require field {code(`${change.unitType}.${change.fieldName}`)}</>
        ),
        effects: [
          "New writes must include it. Existing tasks without it stay readable.",
        ],
      };
    case "artifact-kind-added":
      return {
        title: <>Add artifact kind {code(change.artifactKind)}</>,
        effects: [],
      };
    case "artifact-kind-removed": {
      const lineages =
        "lineageCount" in change && change.lineageCount !== undefined
          ? ` in ${n(change.lineageCount, "lineage")}`
          : "";
      return {
        title: <>Retire artifact kind {code(change.artifactKind)}</>,
        effects: [
          `${n(change.artifactCount, "live artifact")}${lineages} keep their blobs and history. Retiring a kind deletes nothing.`,
        ],
      };
    }
    case "record-type-added":
      return {
        title: <>Add record type {code(change.typeName)}</>,
        effects: [],
      };
    case "record-type-removed": {
      const archived =
        "archivedCount" in change && change.archivedCount
          ? ` and ${n(change.archivedCount, "archived record")}`
          : "";
      return {
        title: <>Retire record type {code(change.typeName)}</>,
        effects: [
          `${n(change.recordCount, "record")}${archived} stay readable; nothing is deleted.`,
        ],
      };
    }
    case "record-field-added":
      return {
        title: (
          <>
            Add record field {code(`${change.typeName}.${change.fieldName}`)} (
            {change.declaration.type})
          </>
        ),
        effects: legacyDefault(change),
      };
    case "record-field-removed":
      return {
        title: (
          <>
            Remove record field {code(`${change.typeName}.${change.fieldName}`)}
          </>
        ),
        effects:
          "recordCount" in change && change.recordCount !== undefined
            ? [
                `${n(change.recordCount, "record")} hold a value. Values stay stored but are no longer declared.`,
              ]
            : [],
      };
    case "record-field-required-added":
      return {
        title: (
          <>
            Require record field{" "}
            {code(`${change.typeName}.${change.fieldName}`)}
          </>
        ),
        effects: [
          "New writes must include it. Existing records stay readable.",
        ],
      };
    case "definition-changed":
      return describeDefinitionChange(change);
  }
}

function describeDefinitionChange(
  change: Extract<Change, { kind: "definition-changed" }>,
): Omit<Line, "key" | "destructive"> {
  const effects: ReactNode[] = [];
  const impact = "impact" in change ? change.impact : undefined;
  if (change.path === "templates")
    effects.push(
      "Only new instantiations use the change; existing work is unaffected.",
    );
  if (change.path.startsWith("artifacts.")) {
    if (impact?.retention) {
      const { from, to, pendingBackfill, pendingBackfillUsesNewPolicy } =
        impact.retention;
      const days = (d: number) => (d === 0 ? "never expire" : n(d, "day"));
      effects.push(
        `Retention ${days(from)} → ${days(to)}. ${n(impact.liveArtifacts, "live artifact")} keep the expiry they already have; new artifacts use the new value.`,
      );
      if (pendingBackfill > 0)
        effects.push(
          pendingBackfillUsesNewPolicy
            ? `${n(pendingBackfill, "older revision")} still waiting for an expiry will use the new value.`
            : `${n(pendingBackfill, "older revision")} still waiting for an expiry keep the policy captured earlier.`,
        );
    } else if (impact) {
      effects.push(
        `${n(impact.liveArtifacts, "live artifact")} keep their current expiry.`,
      );
    }
    if (impact?.searchChanged)
      effects.push(
        "Search settings change; already indexed content is not reindexed.",
      );
  }
  return { title: <>Change {code(change.path)}</>, effects };
}

type FieldRef = { owner: string; field: string; added: Change["kind"] };

function removedField(change: Change): FieldRef | null {
  if (change.kind === "field-removed")
    return {
      owner: change.unitType,
      field: change.fieldName,
      added: "field-added",
    };
  if (change.kind === "record-field-removed")
    return {
      owner: change.typeName,
      field: change.fieldName,
      added: "record-field-added",
    };
  return null;
}

function addedField(change: Change): FieldRef | null {
  if (change.kind === "field-added")
    return {
      owner: change.unitType,
      field: change.fieldName,
      added: change.kind,
    };
  if (change.kind === "record-field-added")
    return {
      owner: change.typeName,
      field: change.fieldName,
      added: change.kind,
    };
  return null;
}

function heldValues(change: Change): number | undefined {
  if (change.kind === "field-removed" && "entityCount" in change)
    return change.entityCount;
  if (change.kind === "record-field-removed" && "recordCount" in change)
    return change.recordCount;
  return undefined;
}

/**
 * The diff reports an edited field as a removal plus an addition of the same
 * name; show that pair as one "change".
 */
function lines(changes: readonly Change[]): Line[] {
  const used = new Set<number>();
  const out: Line[] = [];
  changes.forEach((change, index) => {
    if (used.has(index)) return;
    const removed = removedField(change);
    const pair = removed
      ? changes.findIndex((c, i) => {
          const added = addedField(c);
          return (
            !used.has(i) &&
            added?.added === removed.added &&
            added.owner === removed.owner &&
            added.field === removed.field
          );
        })
      : -1;
    if (removed && pair !== -1) {
      used.add(pair);
      const held = heldValues(change);
      out.push({
        key: `changed:${removed.added}:${removed.owner}.${removed.field}`,
        title: <>Change field {code(`${removed.owner}.${removed.field}`)}</>,
        effects:
          held === undefined
            ? ["Stored values are not rewritten."]
            : [
                `${n(held, "row")} hold a value. Stored values are not rewritten.`,
              ],
        destructive: true,
      });
      return;
    }
    out.push({
      key: `${change.kind}:${index}`,
      ...describe(change),
      destructive: isDestructive(change),
    });
  });
  return out;
}

/**
 * Plain-language list of semantic changes. Destructive ones need an explicit
 * confirmation to apply; the counts come from the server preview.
 */
export function ChangeList({
  changes,
  label = "Changes",
}: {
  changes: readonly Change[];
  label?: string;
}) {
  const items = lines(changes);
  if (items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No semantic changes.</p>
    );
  return (
    <ul
      aria-label={label}
      className="divide-y divide-border rounded-lg border border-border"
    >
      {items.map((item) => (
        <li key={item.key} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>{item.title}</span>
            {item.destructive && (
              <Badge variant="amber">needs confirmation</Badge>
            )}
          </div>
          {item.effects.map((effect, i) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: static per render
              key={i}
              className="text-xs text-muted-foreground"
            >
              {effect}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function destructiveChanges<C extends Change>(
  changes: readonly C[],
): C[] {
  return changes.filter(isDestructive);
}
