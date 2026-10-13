import {
  CheckboxField,
  CheckboxGroup,
  EditorSection,
  LinesField,
} from "@/components/definitions/controls";
import { DeclarationEditor } from "@/components/definitions/declaration-editor";
import { declarationAt } from "@/components/definitions/declaration-table";
import { ProblemSummary } from "@/components/definitions/problem-summary";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import {
  FormNotice,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/form-fields";
import {
  put,
  putDefault,
  stringAt,
  stringList,
  tableAt,
} from "@/lib/definition-values";
import {
  type DefinitionDocument,
  type DefinitionTable,
  declarationNames,
  isTable,
  parseSchemaToml,
  serializeDefinitionDocument,
} from "@tila/core";
import { EntityRelationshipTypeSchema } from "@tila/schemas";
import { type FormEvent, useEffect, useMemo, useState } from "react";

type Props = {
  name: string | null;
  doc: DefinitionDocument;
  /** Applied document, to explain what changes against current data. */
  base: DefinitionDocument | null;
  onSave: (doc: DefinitionDocument, name: string) => void;
  onClose: () => void;
};

function RetentionInput({
  value,
  applied,
  onChange,
  report,
}: {
  value: unknown;
  applied: number | undefined;
  onChange: (days: number) => void;
  report: (problem: string | null) => void;
}) {
  const [raw, setRaw] = useState(
    typeof value === "number" ? String(value) : "0",
  );
  const days = Number(raw);
  const valid = /^\d+$/.test(raw.trim()) && Number.isSafeInteger(days);
  const changed = valid && applied !== undefined && applied !== days;
  return (
    <div className="space-y-1">
      <TextField
        label="Retention (days)"
        hint="0 keeps artifacts until they are deleted."
        inputMode="numeric"
        value={raw}
        error={valid ? undefined : "Enter a whole number of days, 0 or more."}
        onChange={(e) => {
          setRaw(e.target.value);
          const next = Number(e.target.value);
          const ok = /^\d+$/.test(e.target.value.trim());
          report(ok ? null : "Retention must be a whole number of days.");
          if (ok) onChange(next);
        }}
      />
      {changed && (
        <p className="text-xs text-muted-foreground">
          Applied value: {applied === 0 ? "never expire" : `${applied} days`}.
          Existing artifacts keep the expiry they already have; only new ones
          use {days === 0 ? "no expiry" : `${days} days`}. The review shows how
          many artifacts this affects.
        </p>
      )}
    </div>
  );
}

export function ArtifactKindEditor({
  name,
  doc,
  base,
  onSave,
  onClose,
}: Props) {
  const applied = name ? declarationAt(base, "artifacts", name) : null;
  return (
    <DeclarationEditor
      section="artifacts"
      name={name}
      doc={doc}
      noun="artifact kind"
      initial={{ mime_types: ["text/markdown"], retention_days: 0 }}
      onSave={onSave}
      onClose={onClose}
    >
      {(state, update, { name: current, report }) => {
        const d = state.decl;
        const kinds = declarationNames(doc, "artifacts").filter(
          (k) => k !== current,
        );
        return (
          <>
            <EditorSection title="Content">
              <LinesField
                label="Accepted MIME types"
                value={stringList(d.mime_types)}
                onChange={(value) => update((x) => put(x, "mime_types", value))}
              />
              <CheckboxGroup
                legend="Must reference an artifact of kind"
                hint="Writes of this kind must reference one of these kinds."
                options={kinds}
                value={stringList(d.requires_reference_to)}
                onChange={(value) =>
                  update((x) => put(x, "requires_reference_to", value))
                }
              />
              <CheckboxField
                label="A new artifact supersedes the previous one for the same work"
                checked={d.auto_supersedes === true}
                onChange={(checked) =>
                  update((x) =>
                    putDefault(x, "auto_supersedes", checked, false),
                  )
                }
              />
            </EditorSection>
            <EditorSection title="Retention">
              <RetentionInput
                value={d.retention_days}
                applied={
                  typeof applied?.retention_days === "number"
                    ? applied.retention_days
                    : applied
                      ? 0
                      : undefined
                }
                onChange={(days) =>
                  update((x) => putDefault(x, "retention_days", days, 0))
                }
                report={(problem) => report("retention", problem)}
              />
            </EditorSection>
            <EditorSection
              title="Search"
              description="Changing search settings does not reindex content that is already stored."
            >
              <CheckboxField
                label="Index for search"
                checked={d.searchable === true}
                onChange={(checked) =>
                  update((x) => putDefault(x, "searchable", checked, false))
                }
              />
              <SelectField
                label="Search mode"
                value={stringAt(d, "search_mode") || "none"}
                options={[{ value: "none" }, { value: "full_text" }]}
                onChange={(e) =>
                  update((x) =>
                    putDefault(x, "search_mode", e.target.value, "none"),
                  )
                }
              />
            </EditorSection>
          </>
        );
      }}
    </DeclarationEditor>
  );
}

type EntityRow = { key: string; entity: DefinitionTable; data: string };

function entityRows(decl: DefinitionTable): EntityRow[] {
  return Object.entries(tableAt(decl, "entities")).map(([key, raw]) => {
    const entity = isTable(raw) ? raw : {};
    return {
      key,
      entity,
      data: isTable(entity.data) ? JSON.stringify(entity.data, null, 2) : "",
    };
  });
}

function entityProblems(rows: readonly EntityRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.key) return "Every work item needs a key.";
    if (seen.has(row.key)) return `Two work items use the key "${row.key}".`;
    seen.add(row.key);
    if (row.data.trim()) {
      try {
        const parsed: unknown = JSON.parse(row.data);
        if (!isTable(parsed))
          return `Data for "${row.key}" must be a JSON object.`;
      } catch {
        return `Data for "${row.key}" is not valid JSON.`;
      }
    }
  }
  return null;
}

function writeEntities(rows: readonly EntityRow[]): DefinitionTable {
  return Object.fromEntries(
    rows.map((row) => [
      row.key,
      put(
        row.entity,
        "data",
        row.data.trim() ? JSON.parse(row.data) : undefined,
      ),
    ]),
  );
}

export function TemplateEditor({ name, doc, onSave, onClose }: Props) {
  const types = declarationNames(doc, "work_units");
  return (
    <DeclarationEditor
      section="templates"
      name={name}
      doc={doc}
      noun="template"
      initial={{
        entities: { root: { id_suffix: "", type: types[0] ?? "task" } },
      }}
      onSave={onSave}
      onClose={onClose}
    >
      {(state, update, { report, submitted }) => (
        <TemplateBody
          decl={state.decl}
          types={types}
          update={update}
          report={report}
          submitted={submitted}
        />
      )}
    </DeclarationEditor>
  );
}

function TemplateBody({
  decl,
  types,
  update,
  report,
  submitted,
}: {
  decl: DefinitionTable;
  types: readonly string[];
  update: (change: (decl: DefinitionTable) => DefinitionTable) => void;
  report: (key: string, problem: string | null) => void;
  submitted: boolean;
}) {
  const [rows, setRows] = useState(() => entityRows(decl));
  const problem = entityProblems(rows);
  useEffect(() => report("entities", problem), [problem, report]);

  const change = (next: EntityRow[]) => {
    setRows(next);
    if (!entityProblems(next))
      update((d) => ({ ...d, entities: writeEntities(next) }));
  };
  const relationships = Array.isArray(decl.relationships)
    ? decl.relationships.filter(isTable)
    : [];
  const keys = rows.map((r) => r.key).filter(Boolean);
  const setRelationships = (next: DefinitionTable[]) =>
    update((d) => put(d, "relationships", next));
  const relationshipTypes = [...EntityRelationshipTypeSchema.options];

  return (
    <>
      <TextField
        label="Description"
        value={stringAt(decl, "description")}
        onChange={(e) => update((d) => put(d, "description", e.target.value))}
      />
      <EditorSection
        title="Work items created"
        description="Each item's ID is the instantiation root ID plus its suffix. Editing a template never changes work already created from it."
      >
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: keys are being edited
              key={index}
              className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3"
            >
              <TextField
                label="Key"
                required
                value={row.key}
                spellCheck={false}
                className="font-mono"
                onChange={(e) =>
                  change(
                    rows.map((r, i) =>
                      i === index ? { ...r, key: e.target.value.trim() } : r,
                    ),
                  )
                }
              />
              <TextField
                label="ID suffix"
                value={stringAt(row.entity, "id_suffix")}
                spellCheck={false}
                className="font-mono"
                onChange={(e) =>
                  change(
                    rows.map((r, i) =>
                      i === index
                        ? {
                            ...r,
                            entity: { ...r.entity, id_suffix: e.target.value },
                          }
                        : r,
                    ),
                  )
                }
              />
              <SelectField
                label="Work type"
                required
                value={stringAt(row.entity, "type")}
                options={[...new Set([...types, stringAt(row.entity, "type")])]
                  .filter(Boolean)
                  .map((value) => ({ value }))}
                onChange={(e) =>
                  change(
                    rows.map((r, i) =>
                      i === index
                        ? {
                            ...r,
                            entity: { ...r.entity, type: e.target.value },
                          }
                        : r,
                    ),
                  )
                }
              />
              <div className="sm:col-span-3">
                <TextAreaField
                  label="Initial data (JSON object)"
                  rows={3}
                  value={row.data}
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(e) =>
                    change(
                      rows.map((r, i) =>
                        i === index ? { ...r, data: e.target.value } : r,
                      ),
                    )
                  }
                />
              </div>
              <div className="sm:col-span-3">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => change(rows.filter((_, i) => i !== index))}
                >
                  Remove work item {row.key}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {problem && (submitted || rows.some((r) => r.key)) && (
          <p className="text-xs text-status-red">{problem}</p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            change([
              ...rows,
              {
                key: `item_${rows.length + 1}`,
                entity: {
                  id_suffix: `-${rows.length + 1}`,
                  type: types[0] ?? "",
                },
                data: "",
              },
            ])
          }
        >
          Add work item
        </Button>
      </EditorSection>
      <EditorSection title="Relationships between created items">
        {relationships.length === 0 && (
          <p className="text-sm text-muted-foreground">No relationships.</p>
        )}
        <ul className="space-y-2">
          {relationships.map((rel, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
              key={index}
              className="grid items-end gap-3 sm:grid-cols-4"
            >
              {(["from", "type", "to"] as const).map((key) => (
                <SelectField
                  key={key}
                  label={
                    key === "type"
                      ? "Relationship"
                      : key === "from"
                        ? "From"
                        : "To"
                  }
                  value={stringAt(rel, key)}
                  placeholder="Choose"
                  options={[
                    ...new Set([
                      ...(key === "type" ? relationshipTypes : keys),
                      stringAt(rel, key),
                    ]),
                  ]
                    .filter(Boolean)
                    .map((value) => ({ value }))}
                  onChange={(e) =>
                    setRelationships(
                      relationships.map((r, i) =>
                        i === index ? { ...r, [key]: e.target.value } : r,
                      ),
                    )
                  }
                />
              ))}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() =>
                  setRelationships(relationships.filter((_, i) => i !== index))
                }
              >
                Remove relationship
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={keys.length < 2}
          onClick={() =>
            setRelationships([
              ...relationships,
              { from: keys[0], to: keys[1], type: "parent-child" },
            ])
          }
        >
          Add relationship
        </Button>
      </EditorSection>
    </>
  );
}

/** Artifact reference slots on a work type (`work_units.X.references`). */
export function ReferenceSlotsEditor({
  decl,
  doc,
  states,
  update,
  report,
}: {
  decl: DefinitionTable;
  doc: DefinitionDocument;
  /** Lifecycle status values, for trusted-review requirements. */
  states: readonly string[];
  update: (change: (decl: DefinitionTable) => DefinitionTable) => void;
  report: (key: string, problem: string | null) => void;
}) {
  const slots = Array.isArray(decl.references)
    ? decl.references.filter(isTable)
    : [];
  const kinds = declarationNames(doc, "artifacts");
  const names = slots.map((s) => stringAt(s, "name"));
  const duplicate = names.find((n, i) => n && names.indexOf(n) !== i);
  const problem = names.some((n) => !n)
    ? "Every reference slot needs a name."
    : duplicate
      ? `Two reference slots are named "${duplicate}".`
      : null;
  useEffect(() => report("references", problem), [problem, report]);
  const set = (next: DefinitionTable[]) =>
    update((d) => put(d, "references", next));
  const edit = (index: number, key: string, value: unknown) =>
    set(slots.map((s, i) => (i === index ? put(s, key, value) : s)));

  return (
    <EditorSection
      title="Artifact references"
      description="Named slots tasks use to reference artifacts. Removing a slot does not remove existing references."
    >
      {slots.length === 0 && (
        <p className="text-sm text-muted-foreground">No reference slots.</p>
      )}
      <ul className="space-y-3">
        {slots.map((slot, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: names are being edited
            key={index}
            className="space-y-3 rounded-md border border-border p-3"
          >
            <TextField
              label="Slot name"
              required
              value={stringAt(slot, "name")}
              spellCheck={false}
              className="font-mono"
              onChange={(e) => edit(index, "name", e.target.value.trim())}
            />
            <CheckboxField
              label="Allows several artifacts"
              checked={slot.multiple === true}
              onChange={(checked) =>
                set(
                  slots.map((s, i) =>
                    i === index ? putDefault(s, "multiple", checked, false) : s,
                  ),
                )
              }
            />
            <CheckboxGroup
              legend="Artifact kinds"
              options={[...new Set([...kinds, ...stringList(slot.kinds)])]}
              value={stringList(slot.kinds)}
              onChange={(value) =>
                set(
                  slots.map((s, i) =>
                    i === index ? { ...s, kinds: value } : s,
                  ),
                )
              }
            />
            <CheckboxGroup
              legend="Needs a trusted review before these states"
              options={states}
              value={stringList(slot.require_trusted_for_statuses)}
              onChange={(value) =>
                edit(index, "require_trusted_for_statuses", value)
              }
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => set(slots.filter((_, i) => i !== index))}
            >
              Remove slot {stringAt(slot, "name")}
            </Button>
          </li>
        ))}
      </ul>
      {problem && <p className="text-xs text-status-red">{problem}</p>}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          set([...slots, { name: `slot_${slots.length + 1}`, kinds: [] }])
        }
      >
        Add reference slot
      </Button>
    </EditorSection>
  );
}

const TOP_LEVEL = [
  "hierarchy",
  "artifact_relationships",
  "entity_artifact_references",
] as const;

/**
 * Project-wide structure: the work hierarchy and the relationship and
 * reference vocabularies. Writes into the draft only on save.
 */
export function StructureEditor({
  doc,
  onSave,
  onClose,
}: {
  doc: DefinitionDocument;
  onSave: (doc: DefinitionDocument) => void;
  onClose: () => void;
}) {
  const [tables, setTables] = useState(
    () =>
      Object.fromEntries(
        TOP_LEVEL.map((key) => [key, isTable(doc[key]) ? doc[key] : {}]),
      ) as Record<(typeof TOP_LEVEL)[number], DefinitionTable>,
  );
  const [depthRaw, setDepthRaw] = useState(() => {
    const depth = tables.hierarchy.max_depth;
    return typeof depth === "number" ? String(depth) : "";
  });
  const [submitted, setSubmitted] = useState(false);
  const depthError =
    depthRaw.trim() && !/^[1-9]\d*$/.test(depthRaw.trim())
      ? "Enter a whole number of 1 or more, or leave empty."
      : undefined;

  const candidate = useMemo(() => {
    let next = { ...doc };
    for (const key of TOP_LEVEL) next = put(next, key, tables[key]);
    return next;
  }, [doc, tables]);
  const problems = useMemo(() => {
    const parsed = parseSchemaToml(serializeDefinitionDocument(candidate));
    if (parsed.ok) return [];
    return parsed.errors.filter((p) =>
      TOP_LEVEL.some(
        (k) =>
          p.path === k ||
          p.path?.startsWith(`${k}.`) ||
          p.path?.startsWith(`${k}[`),
      ),
    );
  }, [candidate]);
  const setIn = (
    key: (typeof TOP_LEVEL)[number],
    field: string,
    value: unknown,
  ) => setTables((t) => ({ ...t, [key]: put(t[key], field, value) }));

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (depthError) return;
    onSave(candidate);
  }

  return (
    <Drawer title="Hierarchy and relationships" onClose={onClose}>
      <form className="space-y-5 p-6" onSubmit={submit} noValidate>
        <EditorSection
          title="Work hierarchy"
          description="Top level first. Changing it never reparents existing tasks."
        >
          <LinesField
            label="Levels"
            hint={`Declared work types: ${declarationNames(doc, "work_units").join(", ") || "none"}.`}
            value={stringList(tables.hierarchy.levels)}
            onChange={(value) => setIn("hierarchy", "levels", value)}
          />
          <TextField
            label="Maximum depth"
            inputMode="numeric"
            value={depthRaw}
            error={depthError}
            onChange={(e) => {
              setDepthRaw(e.target.value);
              const raw = e.target.value.trim();
              if (!raw) setIn("hierarchy", "max_depth", undefined);
              else if (/^[1-9]\d*$/.test(raw))
                setIn("hierarchy", "max_depth", Number(raw));
            }}
          />
        </EditorSection>
        <EditorSection
          title="Artifact relationship types"
          description="Vocabulary for links between artifacts. Removing a type keeps existing links."
        >
          <LinesField
            label="Relationship types"
            value={stringList(tables.artifact_relationships.types)}
            onChange={(value) =>
              setIn("artifact_relationships", "types", value)
            }
          />
        </EditorSection>
        <EditorSection
          title="Task artifact reference slots"
          description="Project-wide slot names for references from tasks to artifacts. Removing one keeps existing references."
        >
          <LinesField
            label="Reference slots"
            value={stringList(tables.entity_artifact_references.slots)}
            onChange={(value) =>
              setIn("entity_artifact_references", "slots", value)
            }
          />
        </EditorSection>
        {problems.length > 0 && (
          <ProblemSummary
            title="The draft will not validate until these are fixed"
            problems={problems}
            focus={submitted}
          />
        )}
        {submitted && depthError && (
          <FormNotice>Fix the highlighted inputs to save.</FormNotice>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save to draft</Button>
        </div>
      </form>
    </Drawer>
  );
}
