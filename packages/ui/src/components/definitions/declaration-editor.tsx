import {
  FieldsEditor,
  fieldNameProblems,
} from "@/components/definitions/fields-editor";
import { ProblemSummary } from "@/components/definitions/problem-summary";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { TextField } from "@/components/ui/form-fields";
import {
  type DeclarationSection,
  type DefinitionDocument,
  type DefinitionTable,
  type FieldCollection,
  cloneValue,
  getIn,
  isTable,
  parseSchemaToml,
  readFields,
  serializeDefinitionDocument,
  setIn,
  writeFields,
} from "@tila/core";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";

const NAME = /^[A-Za-z0-9_-]+$/;

export type DeclarationState = {
  decl: DefinitionTable;
  /** Field list, for sections whose declarations have fields. */
  fields: FieldCollection | null;
};

/** The declaration as it would be written, with unknown keys kept. */
function compose(
  original: DefinitionTable | null,
  state: DeclarationState,
): DefinitionTable {
  if (!state.fields) return state.decl;
  const empty = state.fields.entries.length === 0;
  if (empty && !(original && "fields" in original)) {
    const { fields: _omit, ...rest } = state.decl;
    return rest;
  }
  return { ...state.decl, fields: writeFields(state.fields) };
}

/**
 * Drawer for one named declaration (`work_units.task`, `records.deploy`, ...).
 * It edits a copy and writes it into the draft only on save, so closing it
 * leaves the draft unchanged. Problems come from the shared core parser.
 */
export function DeclarationEditor({
  section,
  name: originalName,
  doc,
  noun,
  fieldTypes,
  initial,
  onSave,
  onClose,
  children,
}: {
  section: DeclarationSection;
  /** Existing declaration, or null to create one. */
  name: string | null;
  doc: DefinitionDocument;
  /** "work type", "record type", ... */
  noun: string;
  /** Allowed field types; omit for declarations without fields. */
  fieldTypes?: readonly string[];
  /** Starting declaration for a new one. */
  initial?: DefinitionTable;
  onSave: (doc: DefinitionDocument, name: string) => void;
  onClose: () => void;
  children: (
    state: DeclarationState,
    update: (change: (decl: DefinitionTable) => DefinitionTable) => void,
    context: {
      name: string;
      candidate: DefinitionDocument;
      /** Report (or clear) an input problem that must block saving. */
      report: (key: string, problem: string | null) => void;
      /** Whether a save was attempted, so pending problems may be shown. */
      submitted: boolean;
    },
  ) => ReactNode;
}) {
  const original = originalName
    ? ((getIn(doc, [section, originalName]) as DefinitionTable | undefined) ??
      null)
    : null;
  const [name, setName] = useState(originalName ?? "");
  const [state, setState] = useState<DeclarationState>(() => {
    const decl = cloneValue(original ?? initial ?? {});
    return { decl, fields: fieldTypes ? readFields(decl.fields) : null };
  });
  const [typed, setTyped] = useState<Map<number, string>>(new Map());
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const report = useCallback((key: string, problem: string | null) => {
    setInputs((current) => {
      if ((current[key] ?? null) === problem) return current;
      const next = { ...current };
      if (problem) next[key] = problem;
      else delete next[key];
      return next;
    });
  }, []);
  const [submitted, setSubmitted] = useState(false);

  const existing = isTable(doc[section])
    ? Object.keys(doc[section] as DefinitionTable)
    : [];
  const nameError = !name
    ? `Enter a ${noun} name.`
    : !NAME.test(name)
      ? "Use letters, digits, underscores and hyphens."
      : !originalName && existing.includes(name)
        ? `Another ${noun} already has this name.`
        : undefined;
  const fieldProblems = state.fields
    ? fieldNameProblems(state.fields.entries)
    : new Map<number, string>();

  const candidate = useMemo(
    () =>
      nameError ? doc : setIn(doc, [section, name], compose(original, state)),
    [doc, section, name, original, state, nameError],
  );
  const problems = useMemo(() => {
    if (nameError) return [];
    const parsed = parseSchemaToml(serializeDefinitionDocument(candidate));
    if (parsed.ok) return [];
    const prefix = `${section}.${name}`;
    return parsed.errors.filter(
      (p) => p.path === prefix || p.path?.startsWith(`${prefix}.`),
    );
  }, [candidate, section, name, nameError]);

  const blocked =
    Boolean(nameError) ||
    fieldProblems.size > 0 ||
    typed.size > 0 ||
    Object.keys(inputs).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (blocked) return;
    onSave(candidate, name);
  }

  const update = (change: (decl: DefinitionTable) => DefinitionTable) =>
    setState((s) => ({ ...s, decl: change(s.decl) }));

  return (
    <Drawer
      title={originalName ? `Edit ${noun} ${originalName}` : `New ${noun}`}
      onClose={onClose}
    >
      <form className="space-y-5 p-6" onSubmit={submit} noValidate>
        {originalName ? (
          <p className="text-sm text-muted-foreground">
            To rename, duplicate it under the new name and retire this one.
          </p>
        ) : (
          <TextField
            label="Name"
            required
            autoFocus
            value={name}
            spellCheck={false}
            className="font-mono"
            error={submitted || name ? nameError : undefined}
            onChange={(e) => setName(e.target.value.trim())}
          />
        )}
        {state.fields && fieldTypes && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Fields</h3>
            <FieldsEditor
              fields={state.fields}
              types={fieldTypes}
              onChange={(fields) => setState((s) => ({ ...s, fields }))}
              onValidity={setTyped}
            />
          </section>
        )}
        {children(state, update, { name, candidate, report, submitted })}
        {problems.length > 0 && (
          <ProblemSummary
            title="The draft will not validate until these are fixed"
            problems={problems.map((p) => ({
              ...p,
              path: p.path?.slice(section.length + 1),
            }))}
            focus={submitted}
          />
        )}
        {submitted && blocked && (
          <p role="alert" className="text-sm text-status-red">
            Fix the highlighted inputs to save.
          </p>
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
