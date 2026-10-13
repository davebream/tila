import { ProblemSummary } from "@/components/definitions/problem-summary";
import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/form-fields";
import {
  STARTER_DEFINITION,
  analyzeDraft,
  useDefinitionDraft,
} from "@/lib/definition-draft";
import { useDeferredValue, useId, useMemo } from "react";
import { Link } from "react-router";

/**
 * Advanced editing of the draft as TOML. It edits the same draft the forms
 * use and is checked by the same core parser; the server preview decides.
 */
export function SettingsDefinitionsSourcePage() {
  const { project, ready, value, edit, canPreview } = useDefinitionDraft();
  const id = useId();
  const hintId = useId();
  const deferred = useDeferredValue(value);
  const analysis = useMemo(() => analyzeDraft(deferred), [deferred]);
  const back = `/p/${encodeURIComponent(project)}/settings/definitions`;

  return (
    <div className="space-y-4 p-3 md:p-6">
      <header className="space-y-1">
        <Link
          to={back}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Definitions
        </Link>
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Definition source
        </h1>
        <p className="text-sm text-muted-foreground">
          Edit the draft as TOML. Changes stay in this browser tab until you
          review and apply them.
        </p>
      </header>
      {!ready ? null : !canPreview ? (
        <FormNotice tone="info">
          Your access can read definitions but not change them.
        </FormNotice>
      ) : (
        <>
          <div className="space-y-1.5">
            <label htmlFor={id} className="tila-label block">
              Draft (TOML)
            </label>
            <p id={hintId} className="text-xs text-muted-foreground">
              Based on revision {value.baseRevision}.
            </p>
            <textarea
              id={id}
              aria-describedby={hintId}
              aria-invalid={!analysis.ok || undefined}
              spellCheck={false}
              autoCapitalize="off"
              rows={24}
              value={value.source || ""}
              placeholder={STARTER_DEFINITION}
              onChange={(e) => edit(e.target.value)}
              className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs aria-invalid:border-status-red"
            />
          </div>
          {value.source.trim() !== "" && !analysis.ok && (
            <ProblemSummary
              title={
                analysis.syntax ? "TOML syntax error" : "Definition problems"
              }
              problems={analysis.problems}
              focus={false}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to={`${back}/review`}>Review changes</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link to={back}>Back to definitions</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
