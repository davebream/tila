import { ChangeList } from "@/components/definitions/change-list";
import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/form-fields";
import { QuerySection } from "@/components/ui/query-section";
import { listSchemaHistory } from "@/lib/api";
import { definitionChanges, useDefinitionDraft } from "@/lib/definition-draft";
import { deriveSectionState } from "@/lib/query-state";
import { formatDateTime } from "@/lib/time";
import { useQuery } from "@tanstack/react-query";
import type { SchemaHistoryEntry } from "@tila/schemas";
import { useState } from "react";
import { Link, useParams } from "react-router";

/**
 * One historical revision: what it changed and its source. Restoring loads it
 * as a draft on the current revision; applying that records a new revision.
 */
export function SettingsDefinitionsRevisionPage() {
  const { version: raw } = useParams();
  const version = Number(raw);
  const { project, current, dirty, replace, canPreview } = useDefinitionDraft();
  const [replacing, setReplacing] = useState(false);
  const back = `/p/${encodeURIComponent(project)}/settings/definitions`;
  const valid = Number.isSafeInteger(version) && version > 0;

  const history = useQuery({
    queryKey: ["schema-history", project, "revision", version],
    queryFn: () =>
      listSchemaHistory(project, { before: version + 1, limit: 2 }),
    enabled: Boolean(project) && valid,
  });
  const state = deriveSectionState(history, {
    isEmpty: (data) => data.entries[0]?.version !== version,
  });

  function restore(entry: SchemaHistoryEntry) {
    if (!current) return;
    replace(
      {
        baseRevision: current.revision,
        baseSource: current.source,
        source: entry.definition,
        restoredFrom: entry.version,
      },
      `${back}/review`,
    );
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
          Revision {valid ? version : raw}
        </h1>
      </header>
      <QuerySection
        state={state}
        label="revision"
        empty="This revision does not exist."
        onRetry={() => history.refetch()}
      >
        {(data) => {
          const entry = data.entries[0];
          const previous = data.entries[1];
          const changes = definitionChanges(
            previous?.definition ?? "",
            entry.definition,
          );
          const isCurrent = current?.revision === entry.version;
          return (
            <div className="space-y-4">
              <p className="font-mono text-sm">
                Applied {formatDateTime(entry.applied_at)} by {entry.applied_by}
                {entry.strategy ? ` · ${entry.strategy}` : ""}
              </p>
              <section aria-labelledby="revision-changes" className="space-y-2">
                <h2
                  id="revision-changes"
                  className="font-logo text-lg tracking-tight"
                >
                  {previous
                    ? `Changes from revision ${previous.version}`
                    : "Created"}
                </h2>
                {changes ? (
                  <ChangeList changes={changes} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    The changes cannot be summarized; compare the sources below.
                  </p>
                )}
              </section>
              <details className="rounded-lg border border-border bg-card">
                <summary className="cursor-pointer p-3 text-sm">
                  Revision {entry.version} source (TOML)
                </summary>
                <pre className="overflow-x-auto border-t border-border p-3 font-mono text-xs">
                  {entry.definition}
                </pre>
              </details>
              {previous && (
                <details className="rounded-lg border border-border bg-card">
                  <summary className="cursor-pointer p-3 text-sm">
                    Revision {previous.version} source (TOML)
                  </summary>
                  <pre className="overflow-x-auto border-t border-border p-3 font-mono text-xs">
                    {previous.definition}
                  </pre>
                </details>
              )}
              {canPreview && !isCurrent && current && (
                <div className="space-y-2">
                  {replacing ? (
                    <FormNotice tone="warning">
                      You have an unsaved draft. Restoring replaces it.{" "}
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => restore(entry)}
                      >
                        Replace my draft
                      </Button>{" "}
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setReplacing(false)}
                      >
                        Keep my draft
                      </Button>
                    </FormNotice>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        dirty ? setReplacing(true) : restore(entry)
                      }
                    >
                      Restore as a new revision
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Restoring is previewed against current data first. Data
                    written since revision {entry.version} is not changed.
                  </p>
                </div>
              )}
            </div>
          );
        }}
      </QuerySection>
    </div>
  );
}
