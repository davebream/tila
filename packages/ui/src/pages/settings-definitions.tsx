import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuerySection } from "@/components/ui/query-section";
import { useRecordTypes, useWorkCatalog } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { getSchema, listSchemaHistory } from "@/lib/api";
import { deriveSectionState } from "@/lib/query-state";
import { formatDateTime, relativeTime } from "@/lib/time";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  CatalogField,
  RecordCatalogEntry,
  SchemaHistoryEntry,
  WorkCatalogEntry,
} from "@tila/schemas";

const HISTORY_PAGE = 20;

const TH = "p-3 font-medium";

function Heading() {
  return (
    <header className="space-y-1">
      <h1 className="font-logo text-xl tracking-tight text-foreground">
        Definitions
      </h1>
      <p className="text-sm text-muted-foreground">
        The work and record types, fields and lifecycles this project applies.
        Read-only here; editing in the browser is planned.
      </p>
    </header>
  );
}

/** How to apply definitions until the browser editor exists. */
function CliFallback() {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
      <p>No definitions have been applied to this project.</p>
      <p className="text-muted-foreground">
        Until definitions can be edited here, apply them from a checkout with
        the CLI. Preview first, then apply against revision 0:
      </p>
      <pre className="overflow-x-auto rounded-md bg-background p-3 font-mono text-xs">
        {"tila schema diff\ntila schema apply --expected-revision 0"}
      </pre>
      <p className="text-xs text-muted-foreground">
        Tasks and records can still be written without definitions; they are
        just not validated.
      </p>
    </div>
  );
}

function fieldSummary(fields: CatalogField[]): string {
  if (fields.length === 0) return "No fields";
  return fields
    .map((f) => `${f.name}: ${f.type}${f.required ? "" : "?"}`)
    .join(", ");
}

function WorkTypes({ types }: { types: WorkCatalogEntry[] }) {
  if (types.length === 0)
    return <p className="py-3 text-sm text-muted-foreground">No work types.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm" aria-label="Work types">
        <thead className="bg-card text-xs text-muted-foreground">
          <tr>
            <th className={TH}>Type</th>
            <th className={TH}>Fields</th>
            <th className={TH}>Lifecycle</th>
            <th className={`${TH} text-right`}>Tasks</th>
          </tr>
        </thead>
        <tbody>
          {types.map((type) => {
            const lifecycle = type.definition?.lifecycle;
            return (
              <tr key={type.type} className="border-t border-border align-top">
                <th scope="row" className="p-3 font-mono font-normal">
                  {type.type}
                  {type.declaration !== "declared" && (
                    <Badge variant="gray" className="ml-2">
                      {type.declaration === "undeclared"
                        ? "not in schema"
                        : "unknown"}
                    </Badge>
                  )}
                </th>
                <td className="p-3 font-mono text-xs text-muted-foreground">
                  {type.definition ? fieldSummary(type.definition.fields) : "—"}
                </td>
                <td className="p-3 font-mono text-xs text-muted-foreground">
                  {lifecycle
                    ? `${lifecycle.field}: ${lifecycle.dispatchable.join(", ")} → ${lifecycle.terminal.join(", ")}`
                    : "—"}
                </td>
                <td className="p-3 text-right font-mono">
                  {type.count.toLocaleString("en-US")}
                  {type.archived_count > 0 && (
                    <span className="block text-[11px] text-muted-foreground">
                      +{type.archived_count.toLocaleString("en-US")} archived
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecordTypes({ entries }: { entries: RecordCatalogEntry[] }) {
  if (entries.length === 0)
    return (
      <p className="py-3 text-sm text-muted-foreground">No record types.</p>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm" aria-label="Record types">
        <thead className="bg-card text-xs text-muted-foreground">
          <tr>
            <th className={TH}>Type</th>
            <th className={TH}>Fields</th>
            <th className={TH}>Format</th>
            <th className={`${TH} text-right`}>Records</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.type} className="border-t border-border align-top">
              <th scope="row" className="p-3 font-mono font-normal">
                {entry.type}
                {entry.declaration !== "declared" && (
                  <Badge variant="gray" className="ml-2">
                    {entry.declaration === "undeclared"
                      ? "not in schema"
                      : "unknown"}
                  </Badge>
                )}
              </th>
              <td className="p-3 font-mono text-xs text-muted-foreground">
                {entry.definition ? fieldSummary(entry.definition.fields) : "—"}
              </td>
              <td className="p-3 font-mono text-xs text-muted-foreground">
                {entry.definition
                  ? `${entry.definition.format}, ${entry.definition.history} history`
                  : "—"}
              </td>
              <td className="p-3 text-right font-mono">
                {entry.count.toLocaleString("en-US")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

function History() {
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
                        {entry.version}
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

export function SettingsDefinitionsPage() {
  useTimeTick();
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const schema = useQuery({
    queryKey: ["overview", project, "schema"],
    queryFn: () => getSchema(project),
    enabled: Boolean(projectId),
    refetchInterval: 30_000,
  });
  const work = useWorkCatalog();
  const records = useRecordTypes();
  const schemaState = deriveSectionState(schema, {
    isEmpty: (data) => !data.schema,
  });

  return (
    <div className="space-y-8 p-3 md:p-6">
      <Heading />

      <section aria-labelledby="applied-heading" className="space-y-2">
        <h2 id="applied-heading" className="font-logo text-lg tracking-tight">
          Applied revision
        </h2>
        {schemaState.phase === "ready" &&
        schemaState.empty &&
        !schemaState.stale ? (
          <CliFallback />
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
                </div>
              )
            }
          </QuerySection>
        )}
      </section>

      <section aria-labelledby="work-types-heading" className="space-y-2">
        <h2
          id="work-types-heading"
          className="font-logo text-lg tracking-tight"
        >
          Work types
        </h2>
        <QuerySection
          state={deriveSectionState(work, { isEmpty: () => false })}
          label="work types"
          empty="No work types."
          onRetry={() => work.refetch()}
        >
          {(data) => <WorkTypes types={data.types} />}
        </QuerySection>
      </section>

      <section aria-labelledby="record-types-heading" className="space-y-2">
        <h2
          id="record-types-heading"
          className="font-logo text-lg tracking-tight"
        >
          Record types
        </h2>
        <QuerySection
          state={deriveSectionState(records, { isEmpty: () => false })}
          label="record types"
          empty="No record types."
          onRetry={() => records.refetch()}
        >
          {(data) => <RecordTypes entries={data.entries ?? []} />}
        </QuerySection>
      </section>

      <section aria-labelledby="history-heading" className="space-y-2">
        <h2 id="history-heading" className="font-logo text-lg tracking-tight">
          History
        </h2>
        <History />
      </section>
    </div>
  );
}
