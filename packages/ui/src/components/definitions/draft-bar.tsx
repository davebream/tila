import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/form-fields";
import {
  type DefinitionDraftValue,
  useDraftAnalysis,
} from "@/lib/definition-draft";
import { definitionHasComments } from "@tila/core";
import { useState } from "react";
import { Link } from "react-router";

const changeCount = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

/**
 * The unsaved draft's state and next steps. Sticky so the way to review stays
 * visible while editing long definitions.
 */
export function DraftBar({
  base,
  value,
  stale,
  onDiscard,
}: {
  /** `/p/:project/settings/definitions` */
  base: string;
  value: DefinitionDraftValue;
  /** A newer revision was applied after the draft started. */
  stale: boolean;
  onDiscard: () => void;
}) {
  const [discarding, setDiscarding] = useState(false);
  const analysis = useDraftAnalysis(value);
  const summary = analysis.ok
    ? changeCount(analysis.changes.length)
    : analysis.syntax
      ? "TOML syntax error"
      : `${analysis.problems.length} ${analysis.problems.length === 1 ? "problem" : "problems"} to fix`;

  return (
    <section
      aria-label="Unsaved definition draft"
      className="sticky top-0 z-10 space-y-2 rounded-lg border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-sm">
          <span className="font-medium">Unsaved draft</span>{" "}
          <span className="text-muted-foreground">
            on revision {value.baseRevision}
            {value.restoredFrom !== null &&
              `, restoring revision ${value.restoredFrom}`}{" "}
            · {summary}
          </span>
        </p>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to={`${base}/review`}>Review &amp; apply</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to={`${base}/source`}>Edit source</Link>
          </Button>
          {!discarding && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setDiscarding(true)}
            >
              Discard draft
            </Button>
          )}
        </div>
      </div>
      {discarding && (
        <FormNotice tone="warning">
          Discard your unsaved changes? This cannot be undone.{" "}
          <Button
            type="button"
            size="xs"
            variant="destructive"
            onClick={() => {
              setDiscarding(false);
              onDiscard();
            }}
          >
            Discard changes
          </Button>{" "}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setDiscarding(false)}
          >
            Keep editing
          </Button>
        </FormNotice>
      )}
      {stale && (
        <FormNotice tone="warning">
          A newer revision was applied after your draft started. Review it to
          move your draft onto the latest revision.
        </FormNotice>
      )}
      {definitionHasComments(value.baseSource) && (
        <p className="text-xs text-muted-foreground">
          The applied TOML has comments. Form edits and merges rewrite the
          definition without them; text changed in the source editor keeps them.
          History keeps every applied text.
        </p>
      )}
    </section>
  );
}
