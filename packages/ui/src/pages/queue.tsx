import { AttemptDetail } from "@/components/queue/attempt-detail";
import {
  EnrollmentForm,
  EntryEditor,
  PolicyForm,
} from "@/components/queue/controls";
import { Field, inputClass, rights } from "@/components/queue/shared";
import { Button } from "@/components/ui/button";
import { QuerySection, SectionNotice } from "@/components/ui/query-section";
import { useAuth } from "@/hooks/use-auth";
import { inspectQueue, whoami } from "@/lib/api";
import { deriveSectionState } from "@/lib/query-state";
import { useQuery } from "@tanstack/react-query";
import type {
  QueueEntry,
  QueueInspection,
  QueueListQuery,
} from "@tila/schemas";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
export function QueuePage() {
  const { projectId } = useAuth();
  const [params, setParams] = useSearchParams();
  const project = projectId ?? "";
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const state = params.get("state") as QueueListQuery["state"];
  const queryInput: QueueListQuery = {
    limit: 100,
    offset,
    ...(state ? { state } : {}),
    ...Object.fromEntries(
      ["task_id", "type", "target_principal", "capability"]
        .filter((key) => params.get(key))
        .map((key) => [key, params.get(key)]),
    ),
    ...(params.has("priority") && params.get("priority") !== ""
      ? { priority: Number(params.get("priority")) }
      : {}),
  };
  const query = useQuery({
    queryKey: ["queue", project, queryInput],
    queryFn: () => inspectQueue(project, queryInput),
    enabled: !!project,
    refetchInterval: 5_000,
  });
  const identity = useQuery({
    queryKey: ["queue-identity", project],
    queryFn: whoami,
    enabled: !!project,
    refetchInterval: 30_000,
  });
  const currentIdentity =
    identity.isError || identity.fetchStatus === "paused"
      ? undefined
      : identity.data;
  const permission = rights(currentIdentity, project);
  const [editing, setEditing] = useState<QueueEntry | null>(null);
  const attemptId = params.get("attempt");
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "offset" && key !== "attempt") next.delete("offset");
    setParams(next);
  };
  const rows = (data: QueueInspection, stale: boolean) => (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-muted-foreground">Execution capacity</p>
          <p className="text-2xl font-mono">
            {data.counts.execution} /{" "}
            {data.policy.execution_limit ?? "not configured"}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-muted-foreground">Work in progress</p>
          <p className="text-2xl font-mono">
            {data.counts.wip} / {data.policy.wip_limit ?? "uncapped"}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="font-medium">
            {!data.policy.enabled
              ? "Dispatch disabled"
              : data.policy.paused
                ? "Admission paused"
                : "Admission enabled"}
          </p>
          <p className="text-xs text-muted-foreground">
            Policy revision {data.policy.revision} · {data.counts.backlog}{" "}
            waiting
          </p>
          {data.counts.oldest_waiting_age_ms !== null && (
            <p className="text-xs text-muted-foreground">
              Oldest waiting:{" "}
              {Math.floor(data.counts.oldest_waiting_age_ms / 60_000)} min
            </p>
          )}
        </div>
      </div>
      {!!data.diagnostics?.expired_execution_leases && (
        <SectionNotice>
          {data.diagnostics.expired_execution_leases} execution leases have
          expired. Capacity remains reserved; inspect the recorded sessions and
          reconcile before further execution.
        </SectionNotice>
      )}
      <PolicyForm
        project={project}
        policy={data.policy}
        allowed={permission.configure && !stale}
      />
      <EnrollmentForm
        key={`${project}:${params.get("task_id") ?? ""}`}
        project={project}
        task={params.get("task_id") ?? ""}
        allowed={permission.edit && !stale}
      />
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              {[
                "Work",
                "State / blockers",
                "Priority",
                "Target / capabilities",
                "Actions",
              ].map((label) => (
                <th key={label} className="p-3">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.entries.map(({ entry, task, attempt, block_reasons }) => (
              <tr
                key={entry.id}
                className="border-b border-border last:border-0"
              >
                <td className="p-3">
                  <Link
                    className="text-signal-blue"
                    to={`/p/${project}/tasks/${encodeURIComponent(entry.task_id)}`}
                  >
                    {String(
                      task?.data.title ?? task?.data.name ?? entry.task_id,
                    )}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {task?.type ?? "Missing work"} · {entry.task_id}
                  </p>
                </td>
                <td className="p-3">
                  {attempt && entry.state === "admitted"
                    ? attempt.state
                    : entry.state}
                  {attempt?.accepted_at !== null &&
                    attempt?.lease_expires_at != null &&
                    attempt.lease_expires_at <= Date.now() &&
                    attempt.state !== "terminal" && (
                      <p className="text-xs text-status-amber">
                        Authority expired — reconciliation required
                      </p>
                    )}
                  {block_reasons.map((reason, index) => (
                    <p
                      key={`${reason.code}:${index}`}
                      className="text-xs text-status-amber"
                    >
                      {reason.code} {reason.path?.join(" → ")}
                    </p>
                  ))}
                </td>
                <td className="p-3 font-mono">{entry.priority}</td>
                <td className="p-3 text-xs">
                  {entry.target_principal ?? "Any worker"}
                  <p className="text-muted-foreground">
                    {entry.required_capabilities.join(", ") ||
                      "No required capabilities"}
                  </p>
                </td>
                <td className="p-3">
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={
                        !permission.edit ||
                        stale ||
                        !["queued", "admitted"].includes(entry.state)
                      }
                      onClick={() => setEditing(entry)}
                    >
                      Edit
                    </Button>
                    {attempt && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => change("attempt", attempt.id)}
                      >
                        Attempt
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.entries.length && (
          <p className="p-6 text-sm text-muted-foreground">
            No enrolled work matches these filters.
          </p>
        )}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {data.total ? offset + 1 : 0}–
          {Math.min(offset + data.entries.length, data.total)} of {data.total}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => change("offset", String(Math.max(0, offset - 100)))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={offset + 100 >= data.total}
            onClick={() => change("offset", String(offset + 100))}
          >
            Next
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Worker capability context:{" "}
        {data.effective_capabilities.join(", ") || "none supplied"}. Capability
        matching controls scheduling; access permissions are checked separately.
      </p>
    </>
  );
  return (
    <div className="space-y-5 p-4 md:p-6">
      <div>
        <h1 className="font-logo text-2xl">Queue</h1>
        <p className="text-sm text-muted-foreground">
          Shared work for repository-owned pipelines
        </p>
      </div>
      {(identity.isError || identity.fetchStatus === "paused") && (
        <SectionNotice onRetry={() => void identity.refetch()}>
          Permissions unavailable. Queue data remains visible; actions are
          disabled.
        </SectionNotice>
      )}
      <form
        className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6"
        onSubmit={(event) => {
          event.preventDefault();
          const next = new URLSearchParams(params);
          next.delete("offset");
          const values = new FormData(event.currentTarget);
          for (const [key, value] of values) {
            if (String(value)) next.set(key, String(value));
            else next.delete(key);
          }
          setParams(next);
        }}
      >
        <label className="grid gap-1 text-xs text-muted-foreground">
          View
          <select
            name="state"
            aria-label="Queue view"
            className={inputClass}
            defaultValue={state ?? ""}
          >
            <option value="">All work</option>
            {["backlog", "active", "suspended", "uncertain", "terminal"].map(
              (value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ),
            )}
          </select>
        </label>
        <Field
          label="Type"
          name="type"
          defaultValue={params.get("type") ?? ""}
        />
        <Field
          label="Target"
          name="target_principal"
          defaultValue={params.get("target_principal") ?? ""}
        />
        <Field
          label="Capability"
          name="capability"
          defaultValue={params.get("capability") ?? ""}
        />
        <Field
          label="Priority filter"
          name="priority"
          type="number"
          defaultValue={params.get("priority") ?? ""}
        />
        <Button className="self-end">Apply filters</Button>
      </form>
      {params.get("task_id") && (
        <SectionNotice>
          Showing task {params.get("task_id")}.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => change("task_id", "")}
          >
            Show all tasks
          </button>
        </SectionNotice>
      )}
      <QuerySection
        state={deriveSectionState(query)}
        label="queue"
        empty="No queue state."
        onRetry={() => void query.refetch()}
      >
        {(data, { stale }) => (
          <div className="space-y-5">
            {rows(data, !!stale || query.fetchStatus === "paused")}
          </div>
        )}
      </QuerySection>
      {editing && (
        <EntryEditor
          key={editing.id}
          project={project}
          entry={
            query.data?.entries.find((row) => row.entry.id === editing.id)
              ?.entry ?? editing
          }
          allowed={permission.edit && !query.isError}
          close={() => setEditing(null)}
        />
      )}
      {attemptId && (
        <AttemptDetail
          key={attemptId}
          project={project}
          id={attemptId}
          identity={currentIdentity}
          close={() => change("attempt", "")}
        />
      )}
    </div>
  );
}
