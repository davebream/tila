import { ChangeList } from "@/components/definitions/change-list";
import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/form-fields";
import {
  type DefinitionDraftValue,
  STARTER_DEFINITION,
  definitionChanges,
} from "@/lib/definition-draft";
import {
  parseDefinitionDocument,
  rebaseDefinition,
  serializeDefinitionDocument,
} from "@tila/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";

function tree(source: string) {
  const parsed = parseDefinitionDocument(
    source.trim() ? source : STARTER_DEFINITION,
  );
  return parsed.ok ? parsed.doc : null;
}

/**
 * Another revision was applied after the draft started. Nothing was saved and
 * the draft is kept; the user moves it onto the latest revision (merging
 * declaration by declaration) or starts over, then previews again.
 */
export function ConflictPanel({
  value,
  latest,
  onRebase,
  onStartOver,
}: {
  value: DefinitionDraftValue;
  latest: { revision: number; source: string };
  onRebase: (next: DefinitionDraftValue) => void;
  onStartOver: () => void;
}) {
  const headingId = useId();
  const ref = useRef<HTMLElement>(null);
  const [resolutions, setResolutions] = useState<
    Record<string, "mine" | "theirs">
  >({});
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const result = useMemo(() => {
    const base = tree(value.baseSource);
    const mine = tree(value.source);
    const theirs = tree(latest.source);
    if (!base || !mine || !theirs) return null;
    return rebaseDefinition(base, mine, theirs, resolutions);
  }, [value.baseSource, value.source, latest.source, resolutions]);
  const theirChanges = definitionChanges(value.baseSource, latest.source);

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="space-y-3 rounded-lg border border-status-amber/40 p-4 outline-hidden"
    >
      <h2 id={headingId} className="font-logo text-lg tracking-tight">
        Revision {latest.revision} was applied after your draft started
      </h2>
      <p className="text-sm text-muted-foreground">
        Your draft is based on revision {value.baseRevision}. Nothing was saved
        and your draft is kept. Move it onto revision {latest.revision}, then
        review it again.
      </p>
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          Changed in revision {latest.revision}
        </h3>
        {theirChanges ? (
          <ChangeList changes={theirChanges} label="Changes since your draft" />
        ) : (
          <p className="text-sm text-muted-foreground">
            The changes cannot be summarized; compare the sources in History.
          </p>
        )}
      </div>
      {!result ? (
        <FormNotice>
          Your draft has a TOML syntax error, so it cannot be merged. Fix it in
          the source editor or start over from revision {latest.revision}.
        </FormNotice>
      ) : (
        result.conflicts.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Both sides changed these; choose which version to keep
            </legend>
            {result.conflicts.map((path) => (
              <div
                key={path}
                className="flex flex-wrap items-center gap-3 text-sm"
              >
                <code className="font-mono">{path}</code>
                {(["mine", "theirs"] as const).map((side) => (
                  <label key={side} className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`resolve-${path}`}
                      checked={(resolutions[path] ?? "theirs") === side}
                      onChange={() =>
                        setResolutions((r) => ({ ...r, [path]: side }))
                      }
                    />
                    {side === "mine"
                      ? "Keep mine"
                      : `Keep revision ${latest.revision}`}
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
        )
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!result}
          onClick={() =>
            result &&
            onRebase({
              ...value,
              baseRevision: latest.revision,
              baseSource: latest.source,
              source: serializeDefinitionDocument(result.merged),
            })
          }
        >
          Move my draft onto revision {latest.revision}
        </Button>
        <Button type="button" variant="ghost" onClick={onStartOver}>
          Start over from revision {latest.revision}
        </Button>
      </div>
    </section>
  );
}
