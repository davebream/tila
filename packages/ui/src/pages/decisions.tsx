import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/form-fields";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DecisionDetail,
  QUESTION_STATE,
} from "@/components/work/decision-detail";
import { useWhoami } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { listQuestions } from "@/lib/api";
import {
  type DecisionView,
  decisionViewFromSearch,
  questionQueryFromSearch,
} from "@/lib/list-queries";
import { failureKind, failureMessage } from "@/lib/mutation-errors";
import { formatDateTime, relativeTime } from "@/lib/time";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Question } from "@tila/schemas";
import { Link, useLocation, useNavigate, useParams } from "react-router";

const VIEWS: Array<{ id: DecisionView; label: string; empty: string }> = [
  {
    id: "mine",
    label: "Waiting on me",
    empty: "Nothing is waiting on you.",
  },
  { id: "open", label: "All open", empty: "No open questions." },
  { id: "answered", label: "Answered", empty: "No answered questions." },
  { id: "cancelled", label: "Cancelled", empty: "No cancelled questions." },
  {
    id: "superseded",
    label: "Superseded",
    empty: "No superseded questions.",
  },
];

const PAGE = 50;

/**
 * Questions workers asked about their attempts. "Waiting on me" is the inbox:
 * open questions whose designated responder is the signed-in principal,
 * including owner escalations.
 */
export function DecisionsPage() {
  useTimeTick();
  const { projectId } = useAuth();
  const project = projectId ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const view = decisionViewFromSearch(params);
  const escalatedOnly = params.get("escalated") === "1";
  const whoami = useWhoami();
  const me = whoami.data?.principal_id;
  // The Overview counts "Waiting on me" from this same query.
  const filters = questionQueryFromSearch(params, me);
  const { questionId } = useParams<{ questionId: string }>();

  const query = useInfiniteQuery({
    queryKey: ["questions", project, "inbox", filters],
    queryFn: ({ pageParam }) =>
      listQuestions(project, {
        ...filters,
        after_id: pageParam ?? undefined,
        limit: PAGE,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_after_id,
    enabled: Boolean(projectId) && filters !== null,
    refetchInterval: 10_000,
  });

  // IDs are UUIDs, so server order is not chronological; newest first here.
  const rows: Question[] = (query.data?.pages ?? [])
    .flatMap((page) => page.questions.map((item) => item.question))
    .sort((a, b) => b.created_at - a.created_at);
  const total = query.data?.pages[0]?.total;
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  const link = (next: Record<string, string | null>) => {
    const search = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(next))
      if (value === null) search.delete(key);
      else search.set(key, value);
    return `/p/${project}/decisions?${search}`;
  };

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          Decisions
        </h1>
        <span className="font-mono text-[11px] text-fg-faint">
          Questions workers asked while doing work
        </span>
      </div>

      <nav aria-label="Decision views" className="flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <Link
            key={v.id}
            to={link({ view: v.id === "mine" ? null : v.id })}
            aria-current={v.id === view ? "page" : undefined}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-foreground focus-visible:outline-2 focus-visible:outline-signal-blue"
          >
            {v.label}
          </Link>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={escalatedOnly}
          className="ml-auto aria-pressed:border-status-amber"
          onClick={() =>
            navigate(link({ escalated: escalatedOnly ? null : "1" }))
          }
        >
          Escalated only
        </Button>
      </nav>

      {view === "mine" && whoami.isSuccess && !me && (
        <FormNotice tone="info">
          This credential has no principal, so nothing can be waiting on it. Use
          “All open” to see every open question.
        </FormNotice>
      )}
      {query.isError && (
        <FormNotice>
          {failureKind(query.error) === "forbidden"
            ? "Decisions are not available to this credential."
            : `Questions could not be loaded: ${failureMessage(query.error)}`}{" "}
          <Button
            size="xs"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </FormNotice>
      )}
      {query.isPending && query.fetchStatus !== "idle" && (
        <p className="text-sm text-muted-foreground">Loading questions…</p>
      )}

      {query.isSuccess && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {escalatedOnly
            ? "No escalated questions in this view."
            : current.empty}
        </p>
      )}

      {query.isSuccess && total !== undefined && total > 0 && (
        <p className="font-mono text-[11px] text-fg-faint">
          {total.toLocaleString("en-US")}{" "}
          {total === 1 ? "question matches" : "questions match"}
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table aria-label={current.label}>
            <TableHeader>
              <TableRow>
                <TableHead>Question</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Waiting on</TableHead>
                <TableHead className="text-right">Asked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((q) => (
                <TableRow
                  key={q.id}
                  aria-current={q.id === questionId ? "true" : undefined}
                >
                  <TableCell className="min-w-64 max-w-md whitespace-normal font-sans">
                    <Link
                      className="line-clamp-2 text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-signal-blue"
                      to={{
                        pathname: `/p/${project}/decisions/${q.id}`,
                        search: location.search,
                      }}
                    >
                      {q.text}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {q.task_id}
                  </TableCell>
                  <TableCell>
                    <Badge variant={QUESTION_STATE[q.state].variant}>
                      {QUESTION_STATE[q.state].label}
                    </Badge>
                    {q.escalated && (
                      <Badge variant="secondary" className="ml-1">
                        Owner
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="break-all font-mono text-xs">
                    {q.responder_principal_id}
                    {q.responder_principal_id === me && " (you)"}
                  </TableCell>
                  <TableCell
                    className="tila-num text-right text-muted-foreground"
                    title={formatDateTime(q.created_at)}
                  >
                    {relativeTime(q.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {query.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}

      {questionId && (
        <DecisionDetail
          key={questionId}
          project={project}
          id={questionId}
          close={() =>
            navigate({
              pathname: `/p/${project}/decisions`,
              search: location.search,
            })
          }
        />
      )}
    </div>
  );
}
