import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { LastRefreshed } from "@/components/ui/last-refreshed";
import { SectionNotice } from "@/components/ui/query-section";
import { useAdminCapabilities } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import { type OverviewData, useOverview } from "@/hooks/use-overview";
import { useTimeTick } from "@/hooks/use-time-tick";
import { ApiError } from "@/lib/api";
import {
  type AttentionRow,
  type ListLink,
  type OverviewView,
  countLabel,
} from "@/lib/attention";
import type { SectionState } from "@/lib/query-state";
import { formatTime, relativeTime } from "@/lib/time";
import type { ReactNode } from "react";
import { Link } from "react-router";

const LINK =
  "rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue";

function href(prefix: string, link: ListLink) {
  return `${prefix}/${link.segment}${link.search}`;
}

function NextAction({ view, prefix }: { view: OverviewView; prefix: string }) {
  const next = view.next;
  if (!next) return null;
  const findings = view.rows.filter(
    (row) => row.state.kind === "ready" && row.state.total > 0,
  ).length;
  return (
    <section aria-labelledby="next-action" className="space-y-1">
      <h2 id="next-action" className="text-sm font-semibold">
        Next action
      </h2>
      <p className="text-sm">{next.rule.rule}</p>
      <Link to={href(prefix, next.state.link)} className={`${LINK} text-sm`}>
        View {next.state.complete ? "" : "at least "}
        {countLabel(next.rule, next.state.total)}
      </Link>
      {findings > 1 && (
        <p className="text-xs text-muted-foreground">
          {findings} checks below found something.
        </p>
      )}
    </section>
  );
}

function Summary({ data, prefix }: { data: OverviewData; prefix: string }) {
  const { view } = data;
  switch (view.state) {
    case "pending":
      return (
        <output className="block text-sm text-muted-foreground">
          Checking what needs attention…
        </output>
      );
    case "setup":
      return null;
    case "attention":
      return (
        <div className="space-y-3">
          <NextAction view={view} prefix={prefix} />
          {view.incomplete && (
            <SectionNotice>
              Some checks did not complete, so there may be more to do.
            </SectionNotice>
          )}
        </div>
      );
    case "idle":
      return (
        <div className="space-y-1">
          <p className="text-sm">Nothing needs attention.</p>
          <p className="text-xs text-muted-foreground">
            Every check below completed and found nothing.
          </p>
        </div>
      );
    case "partial":
      return (
        <SectionNotice onRetry={data.refetch}>
          Nothing found in the checks that completed, but some did not. This is
          not an all-clear.
        </SectionNotice>
      );
    case "unknown":
      return (
        <div role="alert" className="space-y-1">
          <p className="text-sm text-status-red">Current state unknown.</p>
          <p className="text-xs text-muted-foreground">
            No check could be completed, so nothing here is an all-clear.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={data.refetch}
            className="font-mono text-muted-foreground"
          >
            Retry
          </Button>
        </div>
      );
    case "unchecked":
      return (
        <p className="text-sm text-muted-foreground">
          Your access does not include any attention checks.
        </p>
      );
  }
}

function SetupChecklist({ prefix }: { prefix: string }) {
  const { canManageMemberships, canManageCredentials } = useAdminCapabilities();
  const manages = canManageMemberships || canManageCredentials;
  return (
    <section
      aria-labelledby="setup-heading"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="space-y-1">
        <h2 id="setup-heading" className="text-sm font-semibold">
          Set up this project
        </h2>
        <p className="text-sm text-muted-foreground">
          No definitions are applied and the project has no tasks or records
          yet.
        </p>
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          <span className="font-medium">Definitions.</span> None applied
          (revision 0).{" "}
          <Link to={`${prefix}/settings/definitions`} className={LINK}>
            Review definitions
          </Link>
        </li>
        <li>
          <span className="font-medium">Access.</span>{" "}
          {manages ? (
            <Link to={`${prefix}/settings`} className={LINK}>
              Invite members and manage credentials
            </Link>
          ) : (
            <span className="text-muted-foreground">
              Members and credentials are managed by project owners.
            </span>
          )}
        </li>
      </ol>
    </section>
  );
}

function Observed({ row, prefix }: { row: AttentionRow; prefix: string }) {
  const { state, rule } = row;
  switch (state.kind) {
    case "pending":
      return <span className="text-muted-foreground">Checking…</span>;
    case "failed": {
      const code = state.cause instanceof ApiError ? state.cause.code : null;
      return (
        <span className="text-status-red">
          Could not load {rule.source.label}. Current state unknown.
          {code && (
            <span className="block font-mono text-[11px] text-muted-foreground">
              {code}
            </span>
          )}
        </span>
      );
    }
    case "not-configured":
      return (
        <span className="text-status-amber">
          {rule.source.label.charAt(0).toUpperCase()}
          {rule.source.label.slice(1)}: not configured on this deployment.
        </span>
      );
    case "not-applicable":
      return <span className="text-muted-foreground">{state.reason}</span>;
    case "hidden":
      return null;
    case "ready": {
      const prefixText = state.complete ? "" : "at least ";
      const scope = [state.scope, state.stale ? "last known" : null]
        .filter(Boolean)
        .join(" · ");
      return (
        <span className="space-x-2">
          {state.total > 0 ? (
            <>
              <Badge variant={rule.severity}>
                {rule.severity === "red" ? "urgent" : "review"}
              </Badge>
              <Link
                to={href(prefix, state.link)}
                className={`${LINK} font-mono`}
              >
                {prefixText}
                {countLabel(rule, state.total)}
              </Link>
            </>
          ) : (
            <span className="font-mono text-muted-foreground">
              No {rule.noun[1]}
            </span>
          )}
          {scope && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {scope}
            </span>
          )}
        </span>
      );
    }
  }
}

function AsOf({ row }: { row: AttentionRow }) {
  const { state } = row;
  if (state.kind !== "ready") return null;
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      <time
        dateTime={new Date(state.updatedAt).toISOString()}
        title={formatTime(state.updatedAt)}
      >
        {relativeTime(state.updatedAt)}
      </time>
      {state.stale && (
        <span className="block text-status-amber">refresh failed</span>
      )}
    </span>
  );
}

function AttentionTable({
  view,
  prefix,
}: {
  view: OverviewView;
  prefix: string;
}) {
  if (view.rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm" aria-label="Attention checks">
        <thead className="bg-card text-xs text-muted-foreground">
          <tr>
            <th className="p-3 font-medium">Observed</th>
            <th className="p-3 font-medium">Why it matters</th>
            <th className="p-3 font-medium">As of</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.rule.id} className="border-t border-border align-top">
              <td className="p-3">
                <Observed row={row} prefix={prefix} />
              </td>
              <td className="p-3 text-muted-foreground">{row.rule.rule}</td>
              <td className="p-3">
                <AsOf row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fact({
  label,
  state,
  render,
}: {
  label: string;
  state: SectionState<unknown> | "hidden";
  render: () => ReactNode;
}) {
  if (state === "hidden") return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 py-2">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        {state.phase === "pending" ? (
          <span className="text-muted-foreground">Loading…</span>
        ) : state.phase === "failed" ? (
          <span className="text-status-red">
            Could not load. Current state unknown.
          </span>
        ) : (
          render()
        )}
      </dd>
    </div>
  );
}

function ProjectFacts({
  data,
  prefix,
}: { data: OverviewData; prefix: string }) {
  const { schema, work, records } = data;
  return (
    <section aria-labelledby="project-facts" className="space-y-2">
      <h2 id="project-facts" className="text-sm font-semibold">
        Project
      </h2>
      <dl className="divide-y divide-border text-sm">
        <Fact
          label="Definitions"
          state={schema}
          render={() => {
            if (schema === "hidden" || schema.phase !== "ready") return null;
            const applied = schema.data.schema;
            return (
              <>
                {applied ? (
                  <span className="font-mono">
                    Revision {applied.version}, applied{" "}
                    {relativeTime(applied.applied_at)} by {applied.applied_by}
                  </span>
                ) : (
                  <span>None applied</span>
                )}{" "}
                <Link to={`${prefix}/settings/definitions`} className={LINK}>
                  View definitions
                </Link>
              </>
            );
          }}
        />
        <Fact
          label="Tasks"
          state={work}
          render={() => {
            if (work === "hidden" || work.phase !== "ready") return null;
            if (work.data.incomplete?.in_use_types)
              return (
                <span className="text-muted-foreground">
                  Counts are unavailable.
                </span>
              );
            const total = work.data.types.reduce((n, t) => n + t.count, 0);
            const types = work.data.types.filter((t) => t.count > 0).length;
            return (
              <>
                <span className="font-mono">
                  {total.toLocaleString("en-US")}{" "}
                  {total === 1 ? "task" : "tasks"} in {types}{" "}
                  {types === 1 ? "type" : "types"} · excluding archived
                </span>{" "}
                <Link to={`${prefix}/tasks`} className={LINK}>
                  Open tasks
                </Link>
              </>
            );
          }}
        />
        <Fact
          label="Records"
          state={records}
          render={() => {
            if (records === "hidden" || records.phase !== "ready") return null;
            const entries = records.data.entries;
            if (!entries || records.data.incomplete?.in_use_types)
              return (
                <span className="text-muted-foreground">
                  Counts are unavailable.
                </span>
              );
            const total = entries.reduce((n, e) => n + e.count, 0);
            const types = entries.filter((e) => e.count > 0).length;
            return (
              <>
                <span className="font-mono">
                  {total.toLocaleString("en-US")}{" "}
                  {total === 1 ? "record" : "records"} in {types}{" "}
                  {types === 1 ? "type" : "types"} · excluding archived
                </span>{" "}
                <Link to={`${prefix}/records`} className={LINK}>
                  Open records
                </Link>
              </>
            );
          }}
        />
      </dl>
    </section>
  );
}

export function OverviewPage() {
  useTimeTick();
  const { projectId } = useAuth();
  const prefix = `/p/${projectId}`;
  const data = useOverview();
  const { view } = data;
  const hiddenSources = [
    ...new Set(view.hidden.map((rule) => rule.source.label)),
  ];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="font-logo text-2xl">Overview</h1>
          <LastRefreshed dataUpdatedAt={data.updatedAt || undefined} />
        </div>
        <p className="text-sm text-muted-foreground">
          What needs a person now, from counts you can open. Press <Kbd>⌘K</Kbd>{" "}
          to search and navigate.
        </p>
      </header>
      {view.state === "setup" && <SetupChecklist prefix={prefix} />}
      <Summary data={data} prefix={prefix} />
      <AttentionTable view={view} prefix={prefix} />
      {(hiddenSources.length > 0 || data.restricted) && (
        <div className="space-y-1 text-xs text-muted-foreground">
          {hiddenSources.length > 0 && (
            <p>Not checked with your access: {hiddenSources.join(", ")}.</p>
          )}
          {data.restricted && (
            <p>
              This credential only sees some task and record types; every count
              covers those types only.
            </p>
          )}
        </div>
      )}
      <ProjectFacts data={data} prefix={prefix} />
    </div>
  );
}
