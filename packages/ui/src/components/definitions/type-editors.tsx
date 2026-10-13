import {
  CheckboxField,
  CheckboxGroup,
  EditorSection,
} from "@/components/definitions/controls";
import {
  DeclarationEditor,
  type DeclarationState,
} from "@/components/definitions/declaration-editor";
import { SelectField, TextField } from "@/components/ui/form-fields";
import {
  RECORD_FIELD_TYPES,
  WORK_FIELD_TYPES,
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
} from "@tila/core";
import { LIFECYCLE_OUTCOMES } from "@tila/schemas";

const PRESENTABLE = new Set(["string", "text", "enum"]);

function fieldOptions(state: DeclarationState, presentable = true) {
  return (state.fields?.entries ?? [])
    .filter(
      (f) =>
        f.name && (!presentable || PRESENTABLE.has(String(f.declaration.type))),
    )
    .map((f) => ({ value: f.name }));
}

function PresentationEditor({
  state,
  update,
  slots,
}: {
  state: DeclarationState;
  update: (change: (decl: DefinitionTable) => DefinitionTable) => void;
  slots: readonly ("title" | "summary" | "description")[];
}) {
  const presentation = tableAt(state.decl, "presentation");
  const options = fieldOptions(state);
  return (
    <EditorSection
      title="Presentation"
      description="Which fields lists and detail views show. Display only; never affects validation."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {slots.map((slot) => (
          <SelectField
            key={slot}
            label={slot[0].toUpperCase() + slot.slice(1)}
            value={stringAt(presentation, slot)}
            placeholder="(none)"
            options={options}
            onChange={(e) =>
              update((d) =>
                put(d, "presentation", put(presentation, slot, e.target.value)),
              )
            }
          />
        ))}
      </div>
    </EditorSection>
  );
}

function LifecycleEditor({
  state,
  update,
}: {
  state: DeclarationState;
  update: (change: (decl: DefinitionTable) => DefinitionTable) => void;
}) {
  const lifecycle = state.decl.lifecycle;
  const enabled = typeof lifecycle === "object" && lifecycle !== null;
  const table = tableAt(state.decl, "lifecycle");
  const fieldName = stringAt(table, "field");
  const field = state.fields?.entries.find((f) => f.name === fieldName);
  const states = stringList(field?.declaration.values);
  const outcomes = tableAt(table, "outcomes");
  const set = (key: string, value: unknown) =>
    update((d) => ({
      ...d,
      lifecycle: put(tableAt(d, "lifecycle"), key, value),
    }));
  const group = (key: string, legend: string, hint: string) => (
    <CheckboxGroup
      legend={legend}
      hint={hint}
      options={states}
      value={stringList(table[key])}
      onChange={(value) => set(key, value)}
    />
  );
  return (
    <EditorSection
      title="Lifecycle"
      description="Which status values the work queue may start, treats as finished, and counts as unblocking dependents."
    >
      <CheckboxField
        label="This work type has a lifecycle"
        checked={enabled}
        onChange={(checked) =>
          update((d) => {
            if (!checked) return put(d, "lifecycle", undefined);
            const first = fieldOptions(state).find((o) =>
              state.fields?.entries.some(
                (f) => f.name === o.value && f.declaration.type === "enum",
              ),
            );
            return {
              ...d,
              lifecycle: { field: first?.value ?? "status" },
            };
          })
        }
      />
      {enabled && (
        <div className="space-y-3">
          <SelectField
            label="Status field"
            required
            value={fieldName}
            placeholder="Choose a field"
            options={fieldOptions(state)}
            hint={
              states.length === 0
                ? "Choose an enum field with allowed values to pick states below."
                : undefined
            }
            onChange={(e) => set("field", e.target.value)}
          />
          {group(
            "dispatchable",
            "Startable states",
            "Work in these states can be queued and started.",
          )}
          {group(
            "terminal",
            "Finished states",
            "Work in these states is done; none may also be startable.",
          )}
          {group(
            "dependency_satisfied",
            "States that unblock dependents",
            "Must be finished states.",
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="State when started"
              value={stringAt(table, "on_start")}
              placeholder="(unchanged)"
              options={states.map((value) => ({ value }))}
              onChange={(e) => set("on_start", e.target.value)}
            />
            {LIFECYCLE_OUTCOMES.map((outcome) => (
              <SelectField
                key={outcome}
                label={`State on ${outcome}`}
                value={stringAt(outcomes, outcome)}
                placeholder="(none)"
                options={states.map((value) => ({ value }))}
                onChange={(e) =>
                  set("outcomes", put(outcomes, outcome, e.target.value))
                }
              />
            ))}
          </div>
        </div>
      )}
    </EditorSection>
  );
}

export function WorkTypeEditor({
  name,
  doc,
  initial,
  onSave,
  onClose,
}: {
  name: string | null;
  doc: DefinitionDocument;
  initial?: DefinitionTable;
  onSave: (doc: DefinitionDocument, name: string) => void;
  onClose: () => void;
}) {
  return (
    <DeclarationEditor
      section="work_units"
      name={name}
      doc={doc}
      noun="work type"
      fieldTypes={WORK_FIELD_TYPES}
      initial={initial}
      onSave={onSave}
      onClose={onClose}
    >
      {(state, update, current) => {
        const others = declarationNames(doc, "work_units").filter(
          (t) => t !== current.name,
        );
        return (
          <>
            <EditorSection
              title="Hierarchy"
              description="Which work types may contain this one. Existing tasks are never reparented."
            >
              <CheckboxGroup
                legend="Allowed parents"
                options={others}
                value={stringList(state.decl.parents)}
                onChange={(value) => update((d) => put(d, "parents", value))}
              />
              <CheckboxField
                label="A parent is required"
                checked={state.decl.required_parent === true}
                onChange={(checked) =>
                  update((d) =>
                    putDefault(d, "required_parent", checked, false),
                  )
                }
              />
            </EditorSection>
            <LifecycleEditor state={state} update={update} />
            <PresentationEditor
              state={state}
              update={update}
              slots={["title", "summary", "description"]}
            />
          </>
        );
      }}
    </DeclarationEditor>
  );
}

export function RecordTypeEditor({
  name,
  doc,
  initial,
  onSave,
  onClose,
}: {
  name: string | null;
  doc: DefinitionDocument;
  initial?: DefinitionTable;
  onSave: (doc: DefinitionDocument, name: string) => void;
  onClose: () => void;
}) {
  return (
    <DeclarationEditor
      section="records"
      name={name}
      doc={doc}
      noun="record type"
      fieldTypes={RECORD_FIELD_TYPES}
      initial={initial}
      onSave={onSave}
      onClose={onClose}
    >
      {(state, update) => {
        const d = state.decl;
        const presentation = tableAt(d, "presentation");
        return (
          <>
            <EditorSection title="Storage">
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label="Value format"
                  value={stringAt(d, "format") || "json"}
                  options={[{ value: "json" }, { value: "yaml" }]}
                  hint="How values are accepted and shown; stored as canonical JSON."
                  onChange={(e) =>
                    update((x) =>
                      putDefault(x, "format", e.target.value, "json"),
                    )
                  }
                />
                <SelectField
                  label="History"
                  value={stringAt(d, "history") || "revision"}
                  options={[
                    {
                      value: "revision",
                      label: "revision (in project storage)",
                    },
                    {
                      value: "snapshot",
                      label: "snapshot (also stored as artifacts)",
                    },
                  ]}
                  onChange={(e) =>
                    update((x) =>
                      putDefault(x, "history", e.target.value, "revision"),
                    )
                  }
                />
                <TextField
                  label="Key description"
                  hint="Tells writers what a record key identifies."
                  value={stringAt(d, "key_description")}
                  onChange={(e) =>
                    update((x) => put(x, "key_description", e.target.value))
                  }
                />
                <TextField
                  label="External schema reference"
                  hint="Optional URL or ID of a schema that validates values."
                  value={stringAt(d, "schema_ref")}
                  onChange={(e) =>
                    update((x) => put(x, "schema_ref", e.target.value.trim()))
                  }
                />
              </div>
            </EditorSection>
            <EditorSection
              title="Writers and agents"
              description="Advisory: who is expected to write these records. Not enforced yet."
            >
              <CheckboxGroup
                legend="Expected writers"
                options={["human", "agent"]}
                value={stringList(d.writers)}
                onChange={(value) => update((x) => put(x, "writers", value))}
              />
              <CheckboxField
                label="Expose as an MCP resource"
                checked={d.mcp_resource === true}
                onChange={(checked) =>
                  update((x) => putDefault(x, "mcp_resource", checked, false))
                }
              />
            </EditorSection>
            <EditorSection
              title="Presentation"
              description="Display only; never affects validation."
            >
              <div className="grid gap-3 sm:grid-cols-3">
                {(["title", "summary"] as const).map((slot) => (
                  <SelectField
                    key={slot}
                    label={slot === "title" ? "Title" : "Summary"}
                    value={stringAt(presentation, slot)}
                    placeholder="(none)"
                    options={fieldOptions(state)}
                    onChange={(e) =>
                      update((x) =>
                        put(
                          x,
                          "presentation",
                          put(presentation, slot, e.target.value),
                        ),
                      )
                    }
                  />
                ))}
                <SelectField
                  label="Kind"
                  value={stringAt(presentation, "kind")}
                  placeholder="(not stated)"
                  options={[{ value: "configuration" }, { value: "content" }]}
                  onChange={(e) =>
                    update((x) =>
                      put(
                        x,
                        "presentation",
                        put(presentation, "kind", e.target.value),
                      ),
                    )
                  }
                />
              </div>
            </EditorSection>
          </>
        );
      }}
    </DeclarationEditor>
  );
}
