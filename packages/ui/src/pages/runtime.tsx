import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { QuerySection, SectionNotice } from "@/components/ui/query-section";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import {
  ApiError,
  type RuntimeView,
  getRuntimeView,
  releaseAgentBinding,
} from "@/lib/api";
import { leaseCountdown, leaseExpiryMs } from "@/lib/lease";
import { deriveSectionState } from "@/lib/query-state";
import { relativeTime } from "@/lib/time";
import {
  onlineManager,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { capabilityState, deriveObservation } from "@tila/core";
import { type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

type Row = RuntimeView["rows"][number];
type Occupant = NonNullable<Row["current"]>;
type Observation = Occupant["observation"];

const LIFECYCLE: Record<Observation["lifecycle"], string> = {
  attached: "Attached",
  expired: "Expired",
  replaced: "Replaced",
  released: "Released",
  unbound: "No binding",
  unknown: "Unknown",
};
const LIFECYCLE_VARIANT = {
  attached: "green",
  expired: "red",
  replaced: "amber",
  released: "gray",
  unbound: "gray",
  unknown: "amber",
} as const;
const REASON: Record<Observation["reasons"][number], string> = {
  "run-lease-lapsed": "Run lease lapsed",
  "run-closed": "Run closed",
  "run-revoked": "Run revoked",
  "host-enrollment-revoked": "Host enrollment revoked",
  "run-source-unavailable": "Run data unavailable",
  "run-not-found": "Run not found",
  "epoch-mismatch": "Binding epoch changed",
  "replaced-run-still-active":
    "Its run is still active but holds no mailbox authority",
};

function livenessLabel(observation: Observation) {
  switch (observation.host_liveness) {
    case "online":
      return observation.liveness_basis === "presence"
        ? "Heartbeat fresh"
        : "Run lease valid";
    case "stale":
      return "Heartbeat stale";
    case "offline":
      return "Offline";
    default:
      return "Unknown";
  }
}

/** Re-derive with the local clock, corrected by the server's clock offset. */
function observe(row: Row, occupant: Occupant, nowMs: number): Observation {
  return deriveObservation(
    {
      binding: occupant.binding,
      detail: occupant.binding.detail,
      agent_epoch: row.agent.binding_epoch,
      authority: occupant.authority,
      presence: occupant.presence,
    },
    nowMs,
  );
}

function useServerNow(view: RuntimeView | undefined, receivedAt: number) {
  useTimeTick(1000);
  const skew = view ? view.server_now - receivedAt : 0;
  return Date.now() + skew;
}

function useOnline() {
  return useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
  );
}

function Hidden() {
  return <span className="text-muted-foreground">Details hidden</span>;
}
function Unknown({ children = "Unknown" }: { children?: ReactNode }) {
  return <span className="text-status-amber">{children}</span>;
}
function Short({ id }: { id: string }) {
  return (
    <span className="font-mono" title={id}>
      {id.slice(0, 8)}
    </span>
  );
}

function Mailbox({ observation }: { observation: Observation | null }) {
  const lifecycle = observation?.lifecycle ?? "unbound";
  return (
    <span className="grid gap-0.5">
      <Badge variant={LIFECYCLE_VARIANT[lifecycle]}>
        {LIFECYCLE[lifecycle]}
      </Badge>
      {observation?.detail === "redacted" && (
        <span className="text-xs text-muted-foreground">Details hidden</span>
      )}
      {observation?.reasons.map((reason) => (
        <span key={reason} className="text-xs text-muted-foreground">
          {REASON[reason]}
        </span>
      ))}
    </span>
  );
}

function runState(
  run: Extract<Occupant["run"], { status: "visible" }>,
  now: number,
) {
  // D1 keeps `active` after the lease lapses; show what the lease says.
  return run.state === "active" && leaseExpiryMs(run.lease_expires_at) <= now
    ? "lease lapsed"
    : run.state;
}

function RunCell({ occupant, now }: { occupant: Occupant; now: number }) {
  const { run } = occupant;
  if (run.status === "redacted") return <Hidden />;
  if (run.status === "unknown")
    return (
      <Unknown>
        {run.reason === "not-found" ? "Run not found" : "Unknown"}
      </Unknown>
    );
  return (
    <span className="grid">
      <Short id={run.run_id} />
      <span className="text-xs text-muted-foreground">
        {run.run_role} · {runState(run, now)}
      </span>
    </span>
  );
}

function HostCell({
  occupant,
  observation,
}: { occupant: Occupant; observation: Observation }) {
  const { host } = occupant;
  const name =
    host.status === "enrollment" ? (
      host.name
    ) : host.status === "workload" ? (
      "Workload run"
    ) : host.status === "redacted" ? (
      <Hidden />
    ) : (
      <Unknown />
    );
  return (
    <span className="grid">
      <span>{name}</span>
      <span className="text-xs text-muted-foreground">
        {livenessLabel(observation)}
      </span>
    </span>
  );
}

function SessionCell({ occupant }: { occupant: Occupant }) {
  const { binding } = occupant;
  if (binding.detail === "redacted") return <Hidden />;
  return (
    <span className="grid">
      <span>{binding.harness}</span>
      <span className="font-mono text-xs text-muted-foreground">
        {binding.native_session_ref?.session_id ?? "No native session"}
      </span>
    </span>
  );
}

function AccountCell({ occupant }: { occupant: Occupant }) {
  const { binding } = occupant;
  if (binding.detail === "redacted") return <Hidden />;
  if (!binding.profile)
    return <span className="text-muted-foreground">Not reported</span>;
  return (
    <span className="grid">
      <span>
        {binding.profile.profile_id} · rev {binding.profile.profile_revision}
      </span>
      <span className="text-xs text-muted-foreground">
        {binding.profile.verification === "declared"
          ? "Declared — not verified"
          : "Unknown"}
      </span>
    </span>
  );
}

function LeaseCell({ occupant, now }: { occupant: Occupant; now: number }) {
  const lease = occupant.authority.lease_expires_at;
  if (lease === null) return <Unknown />;
  const expires = leaseExpiryMs(lease);
  return (
    <span className="grid">
      <span>{new Date(expires).toLocaleString()}</span>
      <span className="text-xs text-muted-foreground">
        {occupant.authority.source === "run"
          ? `${expires > now ? "Expires" : "Expired"} ${leaseCountdown(expires, now)}`
          : "Binding snapshot only"}
      </span>
    </span>
  );
}

function SourceNotices({ sources }: { sources: RuntimeView["sources"] }) {
  return (
    <>
      {sources.runs === "unavailable" && (
        <SectionNotice>
          Run data unavailable. Mailbox authority of active bindings is unknown.
        </SectionNotice>
      )}
      {sources.enrollments === "unavailable" && (
        <SectionNotice>Host data unavailable.</SectionNotice>
      )}
      {sources.presence === "forbidden" && (
        <p className="text-xs text-muted-foreground">
          Presence is not visible with your access; host liveness uses run
          leases only.
        </p>
      )}
    </>
  );
}

export function RuntimePage() {
  const { projectId } = useAuth();
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const cursor = searchParams.get("cursor") ?? undefined;
  const query = useQuery({
    queryKey: ["runtime-view", projectId, cursor ?? null],
    queryFn: () => getRuntimeView(projectId as string, { cursor }),
    enabled: !!projectId,
    refetchInterval: 5000,
  });
  const now = useServerNow(query.data, query.dataUpdatedAt);
  const state = deriveSectionState(query, {
    isEmpty: (data) => data.rows.length === 0,
  });
  return (
    <div className="space-y-6 p-4 md:p-6">
      <header>
        <h1 className="font-logo text-2xl">Runtime</h1>
        <p className="text-sm text-muted-foreground">
          Which run, host, session and account currently hold each agent
          mailbox. Runtime state never marks work complete.
        </p>
      </header>
      <QuerySection
        state={state}
        label="runtime observations"
        empty="No agents registered."
        onRetry={() => query.refetch()}
      >
        {(data) => (
          <>
            <SourceNotices sources={data.sources} />
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm" aria-label="Runtime">
                <thead className="bg-card">
                  <tr>
                    {[
                      "Agent",
                      "Mailbox",
                      "Epoch",
                      "Runtime run",
                      "Host",
                      "Session",
                      "Account",
                      "Lease",
                      "Last observed",
                    ].map((label) => (
                      <th key={label} className="p-3">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const occupant = row.current;
                    const observation = occupant
                      ? observe(row, occupant, now)
                      : null;
                    return (
                      <tr key={row.agent.id} className="border-t border-border">
                        <th className="p-3 font-medium" scope="row">
                          <Link
                            className="hover:underline"
                            to={`/p/${projectId}/runtime/${encodeURIComponent(row.agent.id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`}
                          >
                            {row.agent.name}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            {row.agent.id}
                          </span>
                        </th>
                        <td className="p-3">
                          <Mailbox observation={observation} />
                        </td>
                        <td className="p-3 font-mono">
                          {row.agent.binding_epoch}
                        </td>
                        {occupant && observation ? (
                          <>
                            <td className="p-3">
                              <RunCell occupant={occupant} now={now} />
                            </td>
                            <td className="p-3">
                              <HostCell
                                occupant={occupant}
                                observation={observation}
                              />
                            </td>
                            <td className="p-3">
                              <SessionCell occupant={occupant} />
                            </td>
                            <td className="p-3">
                              <AccountCell occupant={occupant} />
                            </td>
                            <td className="p-3">
                              <LeaseCell occupant={occupant} now={now} />
                            </td>
                            <td className="p-3">
                              {observation.last_observed_at === null
                                ? "—"
                                : relativeTime(observation.last_observed_at)}
                            </td>
                          </>
                        ) : (
                          <td className="p-3 text-muted-foreground" colSpan={6}>
                            No current occupant
                            {row.previous &&
                              ` · last binding ${LIFECYCLE[observe(row, row.previous, now).lifecycle].toLowerCase()}`}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className="flex gap-2" aria-label="Runtime pages">
              {cursor && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSearchParams({})}
                >
                  First page
                </Button>
              )}
              {data.next_cursor && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSearchParams({ cursor: data.next_cursor as string })
                  }
                >
                  Next page
                </Button>
              )}
            </nav>
          </>
        )}
      </QuerySection>
      {projectId && agentId && (
        <Drawer
          title={agentId}
          onClose={() =>
            navigate(
              `/p/${projectId}/runtime${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
            )
          }
        >
          <RuntimeDetail project={projectId} agent={agentId} />
        </Drawer>
      )}
    </div>
  );
}

function Fields({ entries }: { entries: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {entries.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{title}</h2>
      {children}
    </section>
  );
}

const CAPABILITY_LABEL = {
  "reported-supported": "Supported (reported)",
  "reported-unsupported": "Unsupported (reported)",
  "not-reported": "Not reported",
} as const;

function OccupantDetail({
  row,
  occupant,
  now,
}: { row: Row; occupant: Occupant; now: number }) {
  const observation = observe(row, occupant, now);
  const { binding, run, host, presence } = occupant;
  const full = binding.detail === "full" ? binding : null;
  return (
    <div className="space-y-4">
      <Section title="Mailbox binding">
        <Fields
          entries={[
            ["State", <Mailbox key="m" observation={observation} />],
            ["Binding", <Short key="b" id={binding.consumer_binding_id} />],
            ["Epoch", binding.binding_epoch],
            ["Wake mechanism", binding.mechanism],
            ["Lease", <LeaseCell key="l" occupant={occupant} now={now} />],
          ]}
        />
      </Section>
      <Section title="Runtime run">
        {run.status === "visible" ? (
          <Fields
            entries={[
              [
                "Run",
                <span key="r" className="font-mono">
                  {run.run_id}
                </span>,
              ],
              ["Role", run.run_role],
              ["State", runState(run, now)],
              [
                "Participant",
                <span key="p" className="font-mono">
                  {run.participant_id}
                </span>,
              ],
              [
                "Principal",
                <span key="pr" className="font-mono">
                  {run.principal_id}
                </span>,
              ],
            ]}
          />
        ) : (
          <RunCell occupant={occupant} now={now} />
        )}
        <p className="text-xs text-muted-foreground">
          Work attempt: none linked. This view does not link attempts yet and
          never infers one from a run.
        </p>
      </Section>
      <Section title="Host">
        <Fields
          entries={[
            [
              "Host",
              host.status === "enrollment" ? (
                `${host.name} (${host.kind})`
              ) : host.status === "workload" ? (
                "Workload run"
              ) : host.status === "redacted" ? (
                <Hidden key="h" />
              ) : (
                <Unknown key="h" />
              ),
            ],
            ["Liveness", livenessLabel(observation)],
            [
              "Enrollment",
              host.status === "enrollment" && host.revoked_at
                ? "Revoked"
                : host.status === "enrollment"
                  ? "Active"
                  : "—",
            ],
            [
              "Environment",
              presence.status === "reported"
                ? [
                    presence.environment.machine,
                    presence.environment.worktree,
                    presence.environment.branch,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Not reported"
                : presence.status === "forbidden"
                  ? "Not permitted"
                  : presence.status === "redacted"
                    ? "Details hidden"
                    : "Not reported",
            ],
            [
              "Last observed",
              observation.last_observed_at === null
                ? "—"
                : relativeTime(observation.last_observed_at),
            ],
          ]}
        />
      </Section>
      <Section title="Native session and account">
        {full ? (
          <Fields
            entries={[
              ["Harness", full.harness],
              [
                "Session",
                full.native_session_ref ? (
                  <span key="s" className="font-mono">
                    {full.native_session_ref.session_id}
                  </span>
                ) : (
                  "No native session"
                ),
              ],
              ["Account", <AccountCell key="a" occupant={occupant} />],
              [
                "Account reference",
                full.profile ? (
                  <span key="ar" className="font-mono">
                    {full.profile.account_ref.slice(0, 12)}…
                  </span>
                ) : (
                  "Not reported"
                ),
              ],
            ]}
          />
        ) : (
          <Hidden />
        )}
      </Section>
      {full && (
        <Section title="Capabilities">
          <Fields
            entries={[
              ["Adapter", full.capability_report.adapter_version],
              [
                "Harness version",
                full.capability_report.harness_version ?? "Not reported",
              ],
              [
                "Runtime version",
                full.capability_report.runtime_version ?? "Not reported",
              ],
              ...Object.keys(full.capability_report.capabilities)
                .sort()
                .map(
                  (key) =>
                    [
                      key,
                      CAPABILITY_LABEL[
                        capabilityState(full.capability_report, key)
                      ],
                    ] as [string, ReactNode],
                ),
            ]}
          />
        </Section>
      )}
    </div>
  );
}

type ReleaseOutcome =
  | { phase: "requested" }
  | { phase: "acknowledged"; at: number }
  | { phase: "rejected"; code: string; message: string }
  | { phase: "unknown"; at: number };

function releaseRejection(error: unknown): ReleaseOutcome {
  if (error instanceof ApiError) {
    const status = error.status;
    if (error.code === "network-error" || status === undefined || status >= 500)
      return { phase: "unknown", at: Date.now() };
    return { phase: "rejected", code: error.code, message: error.message };
  }
  return { phase: "unknown", at: Date.now() };
}

/**
 * Requested, acknowledged and observed are separate facts. Only a later poll
 * that shows the binding gone can report the release as observed.
 */
function ReleaseCommand({
  project,
  row,
  dataUpdatedAt,
}: { project: string; row: Row; dataUpdatedAt: number }) {
  const release = row.commands.release;
  const client = useQueryClient();
  const online = useOnline();
  const [confirming, setConfirming] = useState(false);
  const target = useRef<{ binding: string; epoch: number } | null>(null);
  const [outcome, setOutcome] = useState<ReleaseOutcome | null>(null);
  const mutation = useMutation({
    networkMode: "always",
    mutationFn: (epoch: number) =>
      releaseAgentBinding(project, row.agent.id, epoch),
    onMutate: () => setOutcome({ phase: "requested" }),
    onSuccess: () => setOutcome({ phase: "acknowledged", at: Date.now() }),
    onError: (error) => setOutcome(releaseRejection(error)),
    onSettled: () =>
      client.invalidateQueries({ queryKey: ["runtime-view", project] }),
  });

  const sent = target.current;
  const observed =
    sent &&
    outcome &&
    (outcome.phase === "acknowledged" || outcome.phase === "unknown") &&
    dataUpdatedAt > outcome.at &&
    row.current?.binding.consumer_binding_id !== sent.binding
      ? row.current
        ? `Observed: binding replaced at epoch ${row.current.binding.binding_epoch}`
        : "Observed: binding released"
      : null;

  let status: ReactNode = null;
  if (observed) status = observed;
  else if (outcome?.phase === "requested") status = "Requested…";
  else if (outcome?.phase === "acknowledged")
    status = "Acknowledged by the server; waiting to observe the change.";
  else if (outcome?.phase === "unknown")
    status =
      "Outcome unknown: the server did not answer. Waiting to observe the binding.";
  else if (outcome?.phase === "rejected")
    status =
      outcome.code === "stale-binding"
        ? "Rejected: the binding changed since you loaded it."
        : `Rejected (${outcome.code}): ${outcome.message}`;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Release stops mailbox delivery to this occupant. It does not complete or
        cancel work.
      </p>
      {confirming && release.expected_epoch !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">
            Release epoch {release.expected_epoch}?
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={!online || mutation.isPending}
            onClick={() => {
              const epoch = release.expected_epoch as number;
              target.current = {
                binding: release.consumer_binding_id as string,
                epoch,
              };
              setConfirming(false);
              mutation.mutate(epoch);
            }}
          >
            Confirm release
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={!release.allowed || !online || mutation.isPending}
          onClick={() => setConfirming(true)}
        >
          Release mailbox
        </Button>
      )}
      {!release.allowed && (
        <p className="text-xs text-muted-foreground">
          {release.denied_reason === "no-active-binding"
            ? "No active binding to release."
            : "Your access does not allow releasing this binding."}
        </p>
      )}
      {release.allowed && !online && (
        <p className="text-xs text-muted-foreground">
          Offline: commands are disabled until the connection returns.
        </p>
      )}
      {status && (
        <output className="block text-sm" aria-live="polite">
          {status}
        </output>
      )}
    </div>
  );
}

export function RuntimeDetail({
  project,
  agent,
}: { project: string; agent: string }) {
  const query = useQuery({
    queryKey: ["runtime-view", project, "agent", agent],
    queryFn: () => getRuntimeView(project, { agent }),
    refetchInterval: 5000,
  });
  const now = useServerNow(query.data, query.dataUpdatedAt);
  const state = deriveSectionState(query, {
    isEmpty: (data) => data.rows.length === 0,
  });
  return (
    <div className="space-y-6 p-6">
      <QuerySection
        state={state}
        label="runtime detail"
        empty="Agent not found or archived."
        onRetry={() => query.refetch()}
      >
        {(data) => {
          const row = data.rows[0];
          return (
            <>
              <SourceNotices sources={data.sources} />
              <Section title="Agent">
                <Fields
                  entries={[
                    ["Name", row.agent.name],
                    [
                      "ID",
                      <span key="i" className="font-mono">
                        {row.agent.id}
                      </span>,
                    ],
                    ["Binding epoch", row.agent.binding_epoch],
                    [
                      "Settings",
                      <Link
                        key="s"
                        className="underline"
                        to={`/p/${project}/settings`}
                      >
                        Runtime access is managed in Settings
                      </Link>,
                    ],
                  ]}
                />
              </Section>
              {row.current ? (
                <OccupantDetail row={row} occupant={row.current} now={now} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No current occupant.
                </p>
              )}
              {row.previous && (
                <Section title="Previous occupant">
                  <OccupantDetail row={row} occupant={row.previous} now={now} />
                </Section>
              )}
              <Section title="Commands">
                <ReleaseCommand
                  project={project}
                  row={row}
                  dataUpdatedAt={query.dataUpdatedAt}
                />
                <div className="flex flex-wrap gap-2">
                  {(["reconnect", "stop"] as const).map((name) => (
                    <Button key={name} size="sm" variant="outline" disabled>
                      {name === "reconnect" ? "Reconnect" : "Stop"}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Reconnect and stop: unsupported — no host adapter command.
                </p>
              </Section>
            </>
          );
        }}
      </QuerySection>
    </div>
  );
}
