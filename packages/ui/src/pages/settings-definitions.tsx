import { DefinitionSections } from "@/components/definitions/definition-sections";
import { DraftBar } from "@/components/definitions/draft-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/form-fields";
import { QuerySection } from "@/components/ui/query-section";
import { useRecordTypes, useWorkCatalog } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { listSchemaHistory } from "@/lib/api";
import { STARTER_DEFINITION, useDefinitionDraft } from "@/lib/definition-draft";
import { deriveSectionState } from "@/lib/query-state";
import { formatDateTime, relativeTime } from "@/lib/time";
import type { AppliedNotice } from "@/pages/settings-definitions-review";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { SchemaHistoryEntry } from "@tila/schemas";
import { Link, useLocation } from "react-router";

const HISTORY_PAGE = 20;

const TH = "p-3 font-medium";

function Heading() {
  return (
    <header className="space-y-1">
      <h1 className="font-logo text-xl tracking-tight text-foreground">
        Definitions
      </h1>
      <p className="text-sm text-muted-foreground">
        The work and record types, fields, templates and artifact policies this
        project applies. Changes are drafted here, reviewed against current data
        and applied as a new revision.
      </p>
    </header>
  );
}

/** A project with no applied definitions. */
function FirstDefinitions({
  canPreview,
  onStart,
}: {
  canPreview: boolean;
  onStart: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
      <p>No definitions have been applied to this project.</p>
      {canPreview ? (
        <>
          <p className="text-muted-foreground">
            Start a draft here, review it, then apply it as revision 1. No file
            or terminal is needed.
          </p>
          <Button type="button" onClick={onStart}>
            Start definitions
          </Button>
        </>
      ) : (
        <p className="text-muted-foreground">
          Someone with definition access can start them from this page.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Tasks and records can still be written without definitions; they are
        just not validated.
      </p>
    </div>
  );
}

function changes(entry: SchemaHistoryEntry): string[] {
  if (!entry.change_summary) return [];
  try {
    const parsed: unknown = JSON.parse(entry.change_summary);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function History({ base }: { base: string }) {
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const history = useInfiniteQuery({
    queryKey: ["schema-history", project],
    queryFn: ({ pageParam }) =>
      listSchemaHistory(project, { limit: HISTORY_PAGE, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.entries.length === HISTORY_PAGE
        ? last.entries[last.entries.length - 1]?.version
        : undefined,
    enabled: Boolean(projectId),
  });
  const state = deriveSectionState(history, {
    isEmpty: (data) => (data.pages[0]?.entries.length ?? 0) === 0,
  });
  return (
    <QuerySection
      state={state}
      label="definition history"
      empty="No revisions applied yet."
      onRetry={() => history.refetch()}
    >
      {(data) => (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table
              className="w-full text-left text-sm"
              aria-label="Definition history"
            >
              <thead className="bg-card text-xs text-muted-foreground">
                <tr>
                  <th className={TH}>Revision</th>
                  <th className={TH}>Applied</th>
                  <th className={TH}>By</th>
                  <th className={TH}>Changes</th>
                </tr>
              </thead>
              <tbody>
                {data.pages
                  .flatMap((page) => page.entries)
                  .map((entry) => (
                    <tr
                      key={entry.version}
                      className="border-t border-border align-top"
                    >
                      <th scope="row" className="p-3 font-mono font-normal">
                        <Link
                          to={`${base}/history/${entry.version}`}
                          className="underline-offset-2 hover:underline"
                          aria-label={`Revision ${entry.version}`}
                        >
                          {entry.version}
                        </Link>
                        {entry.strategy && (
                          <Badge variant="amber" className="ml-2">
                            {entry.strategy}
                          </Badge>
                        )}
                      </th>
                      <td className="p-3 font-mono text-xs">
                        {formatDateTime(entry.applied_at)}
                      </td>
                      <td className="p-3 font-mono text-xs">
                        {entry.applied_by}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {changes(entry).join("; ") || "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {history.hasNextPage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          )}
        </>
      )}
    </QuerySection>
  );
}

function AppliedNoticeBanner({ notice }: { notice: AppliedNotice }) {
  return (
    <FormNotice tone="info">
      {notice.kind === "applied"
        ? `Applied as revision ${notice.revision}.`
        : "Nothing changed in the definition itself (only comments or keys outside the definition format differ), so no revision was recorded."}
    </FormNotice>
  );
}

export function SettingsDefinitionsPage() {
  useTimeTick();
  const location = useLocation();
  const notice = (location.state as { definitions?: AppliedNotice } | null)
    ?.definitions;
  const {
    project,
    applied: schema,
    current,
    ready,
    value,
    dirty,
    edit,
    discard,
    canPreview,
  } = useDefinitionDraft();
  const base = `/p/${encodeURIComponent(project)}/settings/definitions`;
  const work = useWorkCatalog();
  const records = useRecordTypes();
  const schemaState = deriveSectionState(schema, {
    isEmpty: (data) => !data.schema,
  });

  return (
    <div className="space-y-8 p-3 md:p-6">
      <Heading />
      {notice && !dirty && <AppliedNoticeBanner notice={notice} />}
      {ready && canPreview && dirty && (
        <DraftBar
          base={base}
          value={value}
          stale={current !== null && current.revision !== value.baseRevision}
          onDiscard={discard}
        />
      )}

      <section aria-labelledby="applied-heading" className="space-y-2">
        <h2 id="applied-heading" className="font-logo text-lg tracking-tight">
          Applied revision
        </h2>
        {schemaState.phase === "ready" &&
        schemaState.empty &&
        !schemaState.stale ? (
          dirty ? (
            <p className="text-sm text-muted-foreground">
              Nothing applied yet. Your draft becomes revision 1.
            </p>
          ) : (
            <FirstDefinitions
              canPreview={ready && canPreview}
              onStart={() => edit(STARTER_DEFINITION, `${base}/source`)}
            />
          )
        ) : (
          <QuerySection
            state={schemaState}
            label="definitions"
            empty="No definitions applied."
            forbidden="Your access does not include project definitions."
            onRetry={() => schema.refetch()}
          >
            {(data) =>
              data.schema && (
                <div className="space-y-2">
                  <p className="font-mono text-sm">
                    Revision {data.schema.version} · applied{" "}
                    <time
                      dateTime={new Date(data.schema.applied_at).toISOString()}
                      title={formatDateTime(data.schema.applied_at)}
                    >
                      {relativeTime(data.schema.applied_at)}
                    </time>{" "}
                    by {data.schema.applied_by}
                  </p>
                  <details className="rounded-lg border border-border bg-card">
                    <summary className="cursor-pointer p-3 text-sm">
                      Definition source (TOML)
                    </summary>
                    <pre className="overflow-x-auto border-t border-border p-3 font-mono text-xs">
                      {data.schema.definition}
                    </pre>
                  </details>
                  {ready && canPreview && !dirty && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={`${base}/source`}>Edit source</Link>
                    </Button>
                  )}
                </div>
              )
            }
          </QuerySection>
        )}
        {ready && !canPreview && (
          <p className="text-xs text-muted-foreground">
            Your access can read definitions but not change them.
          </p>
        )}
      </section>

      <DefinitionSections
        source={dirty ? value.source : (current?.source ?? "")}
        baseSource={current?.source ?? ""}
        editable={ready && canPreview}
        onChange={(source) => edit(source)}
        work={work.data?.types}
        records={records.data?.entries}
      />
      {(work.isError || records.isError) && (
        <FormNotice tone="warning">
          Stored task or record counts could not be loaded; the definitions
          above are complete.
        </FormNotice>
      )}

      <section aria-labelledby="history-heading" className="space-y-2">
        <h2 id="history-heading" className="font-logo text-lg tracking-tight">
          History
        </h2>
        <History base={base} />
      </section>
    </div>
  );
}
