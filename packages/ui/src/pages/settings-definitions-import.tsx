import { ProblemSummary } from "@/components/definitions/problem-summary";
import { Button } from "@/components/ui/button";
import {
  FormNotice,
  SelectField,
  controlClass,
} from "@/components/ui/form-fields";
import { useDefinitionDraft } from "@/lib/definition-draft";
import {
  type ImportFormat,
  readDefinitionFileText,
  readDefinitionInput,
} from "@/lib/definition-transfer";
import type { DefinitionProblem } from "@/lib/mutation-errors";
import { cn } from "@/lib/utils";
import {
  type DefinitionImportMode,
  parseDefinitionDocument,
  planDefinitionImport,
} from "@tila/core";
import { useId, useState } from "react";
import { Link } from "react-router";

const MODES: Array<{
  value: DefinitionImportMode;
  label: string;
  hint: string;
}> = [
  {
    value: "merge",
    label: "Merge",
    hint: "Declarations in the file replace the ones with the same name. Everything the file doesn't mention stays as it is.",
  },
  {
    value: "replace",
    label: "Replace",
    hint: "The file becomes the whole definition. Anything it doesn't mention is removed, and you confirm the removals before applying.",
  },
];

type Outcome =
  | { kind: "problems"; title: string; problems: DefinitionProblem[] }
  | { kind: "no-change"; revision: number };

/**
 * Load a TOML or YAML file into the definitions draft. Nothing is applied
 * here: the draft goes through the usual review against current data and is
 * applied against the revision it was planned on.
 */
export function SettingsDefinitionsImportPage() {
  const { project, current, ready, dirty, replace, canPreview } =
    useDefinitionDraft();
  const back = `/p/${encodeURIComponent(project)}/settings/definitions`;
  const fileId = useId();
  const pasteId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [format, setFormat] = useState<ImportFormat>("auto");
  const [mode, setMode] = useState<DefinitionImportMode>("merge");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmReplaceDraft, setConfirmReplaceDraft] = useState(false);
  const [busy, setBusy] = useState(false);

  const hasInput = file !== null || pasted.trim() !== "";

  async function load() {
    if (!current) return;
    if (dirty && !confirmReplaceDraft) {
      setConfirmReplaceDraft(true);
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      let text = pasted;
      let name = "pasted text";
      if (file) {
        const read = await readDefinitionFileText(file);
        if (!read.ok) {
          setOutcome({
            kind: "problems",
            title: "This file can't be imported",
            problems: [{ message: read.message }],
          });
          return;
        }
        text = read.text;
        name = file.name;
      }
      const input = await readDefinitionInput(text, {
        format: file ? "auto" : format,
        filename: file?.name,
      });
      if (!input.ok) {
        setOutcome({
          kind: "problems",
          title: `${name} can't be imported`,
          problems: input.errors,
        });
        return;
      }
      const base = current.source
        ? parseDefinitionDocument(current.source)
        : null;
      const plan = planDefinitionImport(
        base?.ok ? base.doc : null,
        input.doc,
        mode,
        {
          currentSource: current.source,
          metadata: input.metadata,
          projectId: project,
          revision: current.revision,
        },
      );
      if (!plan.ok) {
        setOutcome({
          kind: "problems",
          title: `Importing ${name} would not give a valid definition`,
          problems: plan.errors,
        });
        return;
      }
      if (plan.noChange) {
        setOutcome({ kind: "no-change", revision: current.revision });
        return;
      }
      replace(
        {
          baseRevision: current.revision,
          baseSource: current.source,
          source: plan.source,
          restoredFrom: null,
          importedFrom: {
            name,
            format: input.format,
            mode,
            warnings: plan.warnings,
          },
        },
        `${back}/review`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 p-3 md:p-6">
      <header className="space-y-1">
        <Link
          to={back}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Definitions
        </Link>
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Import definitions
        </h1>
        <p className="text-sm text-muted-foreground">
          Load a TOML or YAML file, such as a starter file or an export from
          another project, into a draft. Nothing changes until you review the
          draft and apply it.
        </p>
      </header>

      {!ready ? null : !canPreview ? (
        <FormNotice tone="info">
          Your access can read definitions but not change them.
        </FormNotice>
      ) : (
        <form
          className="max-w-3xl space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <div className="grid gap-1">
            <label htmlFor={fileId} className="text-xs text-muted-foreground">
              File (.toml, .yaml or .yml)
            </label>
            <input
              id={fileId}
              type="file"
              accept=".toml,.yaml,.yml"
              className={cn(controlClass, "file:mr-3 file:text-sm")}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setOutcome(null);
              }}
            />
          </div>

          {!file && (
            <div className="space-y-3">
              <div className="grid gap-1">
                <label
                  htmlFor={pasteId}
                  className="text-xs text-muted-foreground"
                >
                  Or paste the definition
                </label>
                <textarea
                  id={pasteId}
                  rows={12}
                  spellCheck={false}
                  autoCapitalize="off"
                  value={pasted}
                  onChange={(event) => {
                    setPasted(event.target.value);
                    setOutcome(null);
                  }}
                  className={cn(controlClass, "font-mono text-xs")}
                />
              </div>
              <div className="max-w-48">
                <SelectField
                  label="Pasted format"
                  value={format}
                  onChange={(event) =>
                    setFormat(event.target.value as ImportFormat)
                  }
                  options={[
                    { value: "auto", label: "Detect" },
                    { value: "toml", label: "TOML" },
                    { value: "yaml", label: "YAML" },
                  ]}
                />
              </div>
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-xs text-muted-foreground">
              How to combine it with revision {current?.revision ?? 0}
            </legend>
            {MODES.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="import-mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => {
                    setMode(option.value);
                    setOutcome(null);
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {outcome?.kind === "problems" && (
            <ProblemSummary title={outcome.title} problems={outcome.problems} />
          )}
          {outcome?.kind === "no-change" && (
            <FormNotice tone="info">
              The file matches revision {outcome.revision}; there is nothing to
              import.
            </FormNotice>
          )}
          {confirmReplaceDraft && (
            <FormNotice tone="warning">
              You have an unsaved draft. Loading this file replaces it.
            </FormNotice>
          )}

          <p className="text-xs text-muted-foreground">
            Comments in the file are not kept. A file exported from tila carries
            its source project and revision, which are only used for warnings.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!hasInput || busy || !current}>
              {busy
                ? "Reading…"
                : confirmReplaceDraft
                  ? "Replace my draft and review"
                  : "Load into draft and review"}
            </Button>
            <Button asChild variant="ghost">
              <Link to={back}>Cancel</Link>
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
