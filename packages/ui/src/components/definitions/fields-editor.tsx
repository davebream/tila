import { CheckboxField } from "@/components/definitions/controls";
import { Button } from "@/components/ui/button";
import {
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/form-fields";
import {
  formatFieldValue,
  freshName,
  parseFieldValue,
  put,
  putDefault,
  splitLines,
  stringList,
} from "@/lib/definition-values";
import {
  type DefinitionTable,
  type FieldCollection,
  type FieldEntry,
  cloneValue,
  copyName,
} from "@tila/core";
import { useId, useState } from "react";

/** UI-only checks that keep a field list from collapsing when serialized. */
export function fieldNameProblems(
  entries: readonly FieldEntry[],
): Map<number, string> {
  const problems = new Map<number, string>();
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (!entry.name.trim()) problems.set(index, "Enter a field name.");
    else if (seen.has(entry.name))
      problems.set(index, "Another field already has this name.");
    else seen.set(entry.name, index);
  });
  return problems;
}

function TypedValueInput({
  label,
  hint,
  type,
  values,
  value,
  onChange,
  onValidity,
}: {
  label: string;
  hint: string;
  type: string;
  values: readonly string[];
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity: (problem: string | null) => void;
}) {
  const [raw, setRaw] = useState(() => formatFieldValue(type, value));
  const [error, setError] = useState<string | null>(null);
  const change = (text: string) => {
    setRaw(text);
    const parsed = parseFieldValue(type, text);
    setError(parsed.ok ? null : parsed.message);
    onValidity(parsed.ok ? null : `${label}: ${parsed.message}`);
    if (parsed.ok) onChange(parsed.value);
  };
  if (type === "enum" || type === "boolean")
    return (
      <SelectField
        label={label}
        hint={hint}
        value={raw}
        placeholder="(none)"
        options={(type === "boolean" ? ["true", "false"] : values).map((v) => ({
          value: v,
        }))}
        onChange={(e) => change(e.target.value)}
      />
    );
  if (type === "json" || type === "list<string>" || type === "text")
    return (
      <TextAreaField
        label={label}
        hint={type === "list<string>" ? `${hint} One item per line.` : hint}
        rows={type === "text" ? 3 : 4}
        value={raw}
        error={error ?? undefined}
        className={type === "json" ? "font-mono text-xs" : undefined}
        onChange={(e) => change(e.target.value)}
      />
    );
  return (
    <TextField
      label={label}
      hint={hint}
      inputMode={type === "number" ? "decimal" : undefined}
      value={raw}
      error={error ?? undefined}
      onChange={(e) => change(e.target.value)}
    />
  );
}

function FieldForm({
  entry,
  types,
  nameError,
  onChange,
  onValidity,
}: {
  entry: FieldEntry;
  types: readonly string[];
  nameError?: string;
  onChange: (entry: FieldEntry) => void;
  onValidity: (problem: string | null) => void;
}) {
  const { declaration } = entry;
  const type = typeof declaration.type === "string" ? declaration.type : "";
  const values = stringList(declaration.values);
  const [valuesRaw, setValuesRaw] = useState(values.join("\n"));
  const [problems, setProblems] = useState<Record<string, string | null>>({});
  const report = (key: string) => (problem: string | null) => {
    const next = { ...problems, [key]: problem };
    setProblems(next);
    onValidity(Object.values(next).find(Boolean) ?? null);
  };
  const set = (key: string, value: unknown) =>
    onChange({ ...entry, declaration: put(declaration, key, value) });
  // Typed inputs re-mount when the type changes, so their text is re-derived.
  const typed = `${type}:${values.join(",")}`;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField
        label="Name"
        required
        value={entry.name}
        error={nameError}
        spellCheck={false}
        className="font-mono"
        onChange={(e) => onChange({ ...entry, name: e.target.value.trim() })}
      />
      <SelectField
        label="Type"
        required
        value={type}
        options={[...new Set([...types, ...(type ? [type] : [])])].map((t) => ({
          value: t,
        }))}
        onChange={(e) =>
          onChange({
            ...entry,
            declaration: put(
              put(
                put(declaration, "type", e.target.value),
                "default",
                undefined,
              ),
              "default_for_legacy",
              undefined,
            ),
          })
        }
      />
      <div className="sm:col-span-2">
        <CheckboxField
          label="Required"
          hint="New and updated items must include a value."
          checked={declaration.required === true}
          onChange={(checked) =>
            onChange({
              ...entry,
              declaration: putDefault(declaration, "required", checked, false),
            })
          }
        />
      </div>
      {type === "enum" && (
        <div className="sm:col-span-2">
          <TextAreaField
            label="Allowed values"
            hint="One value per line."
            rows={4}
            value={valuesRaw}
            className="font-mono text-xs"
            onChange={(e) => {
              setValuesRaw(e.target.value);
              set("values", splitLines(e.target.value));
            }}
          />
        </div>
      )}
      <TypedValueInput
        key={`default:${typed}`}
        label="Default"
        hint="Used when a new item has no value."
        type={type}
        values={values}
        value={declaration.default}
        onChange={(value) => set("default", value)}
        onValidity={report("default")}
      />
      <TypedValueInput
        key={`legacy:${typed}`}
        label="Default for existing items"
        hint="Existing items without a value read this lazily; they are not rewritten."
        type={type}
        values={values}
        value={declaration.default_for_legacy}
        onChange={(value) => set("default_for_legacy", value)}
        onValidity={report("default_for_legacy")}
      />
    </div>
  );
}

function summary(entry: FieldEntry): string {
  const type = String(entry.declaration.type ?? "?");
  return `${type}${entry.declaration.required === true ? ", required" : ""}`;
}

/**
 * Edit a field list in place. The list keeps its TOML shape (array of tables
 * or keyed table) and every key a field already had.
 */
export function FieldsEditor({
  fields,
  types,
  onChange,
  onValidity,
}: {
  fields: FieldCollection;
  types: readonly string[];
  onChange: (fields: FieldCollection) => void;
  /** Problems in typed inputs that block saving, by field position. */
  onValidity: (problems: Map<number, string>) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [typed, setTyped] = useState<Map<number, string>>(() => new Map());
  const nameProblems = fieldNameProblems(fields.entries);
  const entries = fields.entries;

  const replace = (next: FieldEntry[], reset = false) => {
    onChange({ ...fields, entries: next });
    if (reset) {
      setTyped(new Map());
      onValidity(new Map());
    }
  };
  const toggle = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div className="space-y-2">
      {entries.length === 0 && (
        <p className="text-sm text-muted-foreground">No fields declared.</p>
      )}
      <ul className="space-y-2">
        {entries.map((entry, index) => {
          const expanded = open.has(index);
          const panel = `${id}-field-${index}`;
          const problem = nameProblems.get(index) ?? typed.get(index);
          return (
            <li
              // Position is the identity while a name is being typed.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              className="rounded-md border border-border"
            >
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panel}
                  className="min-w-0 flex-1 text-left text-sm"
                  onClick={() => toggle(index)}
                >
                  <span className="font-mono">{entry.name || "(unnamed)"}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {summary(entry)}
                  </span>
                  {problem && (
                    <span className="block text-xs text-status-red">
                      {problem}
                    </span>
                  )}
                </button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={`Duplicate field ${entry.name}`}
                  onClick={() => {
                    replace([
                      ...entries,
                      {
                        name: copyName(
                          entries.map((e) => e.name),
                          entry.name || "field",
                        ),
                        declaration: cloneValue(entry.declaration),
                      },
                    ]);
                    setOpen((o) => new Set(o).add(entries.length));
                  }}
                >
                  Duplicate
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove field ${entry.name}`}
                  onClick={() => {
                    replace(
                      entries.filter((_, i) => i !== index),
                      true,
                    );
                    setOpen(new Set());
                  }}
                >
                  Remove
                </Button>
              </div>
              {expanded && (
                <div id={panel} className="border-t border-border p-3">
                  <FieldForm
                    entry={entry}
                    types={types}
                    nameError={nameProblems.get(index)}
                    onChange={(next) =>
                      replace(entries.map((e, i) => (i === index ? next : e)))
                    }
                    onValidity={(message) => {
                      const next = new Map(typed);
                      if (message) next.set(index, message);
                      else next.delete(index);
                      setTyped(next);
                      onValidity(next);
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          replace([
            ...entries,
            {
              name: freshName(
                entries.map((e) => e.name),
                "field",
              ),
              declaration: { type: "string" } as DefinitionTable,
            },
          ]);
          setOpen((o) => new Set(o).add(entries.length));
        }}
      >
        Add field
      </Button>
    </div>
  );
}
