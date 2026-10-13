import {
  type DeclarationActions,
  type DeclarationRow,
  DeclarationTable,
  declarationAt,
  declarationRows,
} from "@/components/definitions/declaration-table";
import {
  RecordTypeEditor,
  WorkTypeEditor,
} from "@/components/definitions/type-editors";
import { FormNotice } from "@/components/ui/form-fields";
import { STARTER_DEFINITION } from "@/lib/definition-draft";
import { stringAt, stringList, tableAt } from "@/lib/definition-values";
import {
  type DeclarationSection,
  type DefinitionDocument,
  cloneDeclaration,
  copyName,
  declarationNames,
  parseDefinitionDocument,
  readFields,
  removeDeclaration,
  sameDefinitionValue,
  serializeDefinitionDocument,
  setIn,
} from "@tila/core";
import type { RecordCatalogEntry, WorkCatalogEntry } from "@tila/schemas";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";

function documentOf(source: string): DefinitionDocument | null {
  const parsed = parseDefinitionDocument(
    source.trim() ? source : STARTER_DEFINITION,
  );
  return parsed.ok ? parsed.doc : null;
}

function fieldSummary(row: DeclarationRow): string {
  const { entries } = readFields(row.decl?.fields);
  if (entries.length === 0) return "No fields";
  return entries
    .map(
      (f) =>
        `${f.name}: ${String(f.declaration.type ?? "?")}${f.declaration.required === true ? "" : "?"}`,
    )
    .join(", ");
}

function lifecycleSummary(row: DeclarationRow): string {
  const lifecycle = tableAt(row.decl ?? {}, "lifecycle");
  const field = stringAt(lifecycle, "field");
  if (!field) return "—";
  return `${field}: ${stringList(lifecycle.dispatchable).join(", ")} → ${stringList(lifecycle.terminal).join(", ")}`;
}

/** `?edit=work_units:task`, or `?edit=work_units:` for a new declaration. */
function parseEdit(value: string | null) {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at === -1) return null;
  return {
    section: value.slice(0, at) as DeclarationSection,
    name: value.slice(at + 1) || null,
  };
}

/**
 * The draft's declarations, section by section, with editors. Edits write the
 * serialized document back into the draft through `onChange`.
 */
export function DefinitionSections({
  source,
  baseSource,
  editable,
  onChange,
  work,
  records,
  children,
}: {
  /** Draft text, or the applied text when nothing is drafted. */
  source: string;
  baseSource: string;
  editable: boolean;
  onChange: (source: string) => void;
  work?: readonly WorkCatalogEntry[];
  records?: readonly RecordCatalogEntry[];
  /** Further sections; receives the shared document and actions. */
  children?: (context: SectionContext) => ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const doc = documentOf(source);
  const base = baseSource.trim() ? documentOf(baseSource) : null;
  const editing = parseEdit(params.get("edit"));
  const canEdit = editable && doc !== null;

  const open = (section: DeclarationSection, name: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set("edit", `${section}:${name ?? ""}`);
        return next;
      },
      { replace: false },
    );
  const close = () =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("edit");
        return next;
      },
      { replace: true },
    );
  // Undoing every change returns the exact applied text, so the draft is
  // no longer considered dirty.
  const write = (next: DefinitionDocument) =>
    onChange(
      base && sameDefinitionValue(next, base)
        ? baseSource
        : serializeDefinitionDocument(next),
    );

  const actionsFor = (
    section: DeclarationSection,
  ): DeclarationActions | undefined =>
    canEdit && doc
      ? {
          onEdit: (name) => open(section, name),
          onDuplicate: (name) => {
            const copy = copyName(declarationNames(doc, section), name);
            write(cloneDeclaration(doc, section, name, copy));
            open(section, copy);
          },
          onRetire: (name) => write(removeDeclaration(doc, section, name)),
          onRestore: (name) => {
            const applied = declarationAt(base, section, name);
            if (applied) write(setIn(doc, [section, name], applied));
          },
          onDeclare: (name) => {
            write(setIn(doc, [section, name], {}));
            open(section, name);
          },
        }
      : undefined;

  const context: SectionContext = {
    doc,
    base,
    canEdit,
    actionsFor,
    open,
    close,
    editing,
    save: (next) => {
      write(next);
      close();
    },
  };

  return (
    <>
      {editable && !doc && (
        <FormNotice tone="warning">
          The draft has a TOML syntax error, so the forms are read-only. Fix it
          in the source editor.
        </FormNotice>
      )}
      <section aria-labelledby="work-types-heading" className="space-y-2">
        <h2
          id="work-types-heading"
          className="font-logo text-lg tracking-tight"
        >
          Work types
        </h2>
        <DeclarationTable
          label="Work types"
          noun="work type"
          rows={declarationRows("work_units", doc ?? {}, base, work)}
          columns={[
            { header: "Fields", cell: fieldSummary },
            { header: "Lifecycle", cell: lifecycleSummary },
          ]}
          countLabel="Tasks"
          actions={actionsFor("work_units")}
          onAdd={canEdit ? () => open("work_units", null) : undefined}
        />
      </section>
      <section aria-labelledby="record-types-heading" className="space-y-2">
        <h2
          id="record-types-heading"
          className="font-logo text-lg tracking-tight"
        >
          Record types
        </h2>
        <DeclarationTable
          label="Record types"
          noun="record type"
          rows={declarationRows("records", doc ?? {}, base, records)}
          columns={[
            { header: "Fields", cell: fieldSummary },
            {
              header: "Format",
              cell: (row) =>
                `${stringAt(row.decl ?? {}, "format") || "json"}, ${stringAt(row.decl ?? {}, "history") || "revision"} history`,
            },
          ]}
          countLabel="Records"
          actions={actionsFor("records")}
          onAdd={canEdit ? () => open("records", null) : undefined}
        />
      </section>
      {children?.(context)}
      {canEdit && doc && editing?.section === "work_units" && (
        <WorkTypeEditor
          key={editing.name ?? "new"}
          name={editing.name}
          doc={doc}
          onSave={context.save}
          onClose={close}
        />
      )}
      {canEdit && doc && editing?.section === "records" && (
        <RecordTypeEditor
          key={editing.name ?? "new"}
          name={editing.name}
          doc={doc}
          onSave={context.save}
          onClose={close}
        />
      )}
    </>
  );
}

export type SectionContext = {
  doc: DefinitionDocument | null;
  base: DefinitionDocument | null;
  canEdit: boolean;
  actionsFor: (section: DeclarationSection) => DeclarationActions | undefined;
  open: (section: DeclarationSection, name: string | null) => void;
  close: () => void;
  editing: { section: DeclarationSection; name: string | null } | null;
  save: (doc: DefinitionDocument) => void;
};
