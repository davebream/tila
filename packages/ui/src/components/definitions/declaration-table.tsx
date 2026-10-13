import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type DeclarationSection,
  type DefinitionDocument,
  type DefinitionTable,
  getIn,
  isTable,
  sameDefinitionValue,
} from "@tila/core";
import type { ReactNode } from "react";

/**
 * A declaration compared with the applied revision: `retired` is removed by
 * the draft, `undeclared` has stored data but no declaration in either.
 */
export type RowStatus =
  | "applied"
  | "new"
  | "changed"
  | "retired"
  | "undeclared";

export type DeclarationRow = {
  name: string;
  status: RowStatus;
  /** Draft declaration, or the applied one for a retired row. */
  decl: DefinitionTable | null;
  count?: number;
  archived?: number;
};

type Counts = { type: string; count: number; archived_count: number };

function table(doc: DefinitionDocument | null, section: DeclarationSection) {
  const value = doc?.[section];
  return isTable(value) ? value : {};
}

export function declarationRows(
  section: DeclarationSection,
  draft: DefinitionDocument,
  base: DefinitionDocument | null,
  counts: readonly Counts[] = [],
): DeclarationRow[] {
  const mine = table(draft, section);
  const theirs = table(base, section);
  const byType = new Map(counts.map((c) => [c.type, c]));
  const names = [
    ...new Set([
      ...Object.keys(mine),
      ...Object.keys(theirs),
      ...counts
        .filter((c) => c.count + c.archived_count > 0)
        .map((c) => c.type),
    ]),
  ];
  return names.map((name) => {
    const inDraft = isTable(mine[name])
      ? (mine[name] as DefinitionTable)
      : null;
    const inBase = isTable(theirs[name])
      ? (theirs[name] as DefinitionTable)
      : null;
    const status: RowStatus = inDraft
      ? !inBase
        ? "new"
        : sameDefinitionValue(inDraft, inBase)
          ? "applied"
          : "changed"
      : inBase
        ? "retired"
        : "undeclared";
    const c = byType.get(name);
    return {
      name,
      status,
      decl: inDraft ?? inBase,
      count: c?.count,
      archived: c?.archived_count,
    };
  });
}

const BADGES: Record<Exclude<RowStatus, "applied">, ReactNode> = {
  new: <Badge variant="default">new in draft</Badge>,
  changed: <Badge variant="default">changed in draft</Badge>,
  retired: <Badge variant="amber">retired on apply</Badge>,
  undeclared: <Badge variant="gray">not in definitions</Badge>,
};

export type DeclarationActions = {
  onEdit: (name: string) => void;
  onDuplicate: (name: string) => void;
  onRetire: (name: string) => void;
  onRestore: (name: string) => void;
  onDeclare: (name: string) => void;
};

/**
 * Declarations of one section as a table with per-row actions. Retiring only
 * removes the declaration; stored data stays readable.
 */
export function DeclarationTable({
  label,
  noun,
  rows,
  columns,
  countLabel,
  actions,
  onAdd,
}: {
  label: string;
  noun: string;
  rows: readonly DeclarationRow[];
  columns: ReadonlyArray<{
    header: string;
    cell: (row: DeclarationRow) => ReactNode;
  }>;
  /** Header for the stored-data count column; omitted when there is none. */
  countLabel?: string;
  /** Absent when the viewer cannot draft or the draft has a syntax error. */
  actions?: DeclarationActions;
  onAdd?: () => void;
}) {
  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">No {noun}s.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm" aria-label={label}>
            <thead className="bg-card text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Name</th>
                {columns.map((c) => (
                  <th key={c.header} className="p-3 font-medium">
                    {c.header}
                  </th>
                ))}
                {countLabel && (
                  <th className="p-3 text-right font-medium">{countLabel}</th>
                )}
                {actions && (
                  <th className="p-3 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.name}
                  className={`border-t border-border align-top ${row.status === "retired" ? "text-muted-foreground" : ""}`}
                >
                  <th scope="row" className="p-3 font-mono font-normal">
                    <span
                      className={row.status === "retired" ? "line-through" : ""}
                    >
                      {row.name}
                    </span>
                    {row.status !== "applied" && (
                      <span className="ml-2">{BADGES[row.status]}</span>
                    )}
                  </th>
                  {columns.map((c) => (
                    <td
                      key={c.header}
                      className="p-3 font-mono text-xs text-muted-foreground"
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {countLabel && (
                    <td className="p-3 text-right font-mono">
                      {(row.count ?? 0).toLocaleString("en-US")}
                      {!!row.archived && (
                        <span className="block text-[11px] text-muted-foreground">
                          +{row.archived.toLocaleString("en-US")} archived
                        </span>
                      )}
                    </td>
                  )}
                  {actions && (
                    <td className="p-2">
                      <RowActions row={row} noun={noun} actions={actions} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {onAdd && (
        <Button type="button" size="sm" variant="outline" onClick={onAdd}>
          Add {noun}
        </Button>
      )}
    </div>
  );
}

function RowActions({
  row,
  noun,
  actions,
}: {
  row: DeclarationRow;
  noun: string;
  actions: DeclarationActions;
}) {
  const label = (verb: string) => `${verb} ${noun} ${row.name}`;
  const button = (verb: string, onClick: () => void, title = verb) => (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      aria-label={label(verb)}
      onClick={onClick}
    >
      {title}
    </Button>
  );
  if (row.status === "retired")
    return (
      <div className="flex justify-end">
        {button("Restore", () => actions.onRestore(row.name), "Undo retire")}
      </div>
    );
  if (row.status === "undeclared")
    return (
      <div className="flex justify-end">
        {button("Declare", () => actions.onDeclare(row.name))}
      </div>
    );
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {button("Edit", () => actions.onEdit(row.name))}
      {button("Duplicate", () => actions.onDuplicate(row.name))}
      {row.status === "new"
        ? button("Remove", () => actions.onRetire(row.name))
        : button("Retire", () => actions.onRetire(row.name))}
    </div>
  );
}

export function declarationAt(
  doc: DefinitionDocument | null,
  section: DeclarationSection,
  name: string,
): DefinitionTable | null {
  const value = doc ? getIn(doc, [section, name]) : undefined;
  return isTable(value) ? value : null;
}
