import {
  type AgentRuntimePage,
  type CapabilityReport,
  type ConsumerBinding,
  RUNTIME_PRESENCE_TTL_MS,
  type RuntimeAuthority,
  type RuntimeBinding,
  type RuntimeCommands,
  type RuntimeHostLiveness,
  type RuntimeHostObservation,
  type RuntimeObservation,
  type RuntimeObservationReason,
  type RuntimeOccupant,
  type RuntimePresenceObservation,
  type RuntimeRunObservation,
  type RuntimeViewResponse,
  type RuntimeViewRow,
} from "@tila/schemas";

/** Who is looking at a binding. Run IDs come only from verified credentials. */
export interface BindingViewer {
  principal_id: string;
  can_manage: boolean;
  run_id?: string | null;
}

/**
 * Full binding evidence (native session, profile, holder identities) is
 * visible to agent managers, the agent owner and the run that holds it.
 */
export function bindingDetailVisible(
  ownerPrincipalId: string,
  binding: Pick<ConsumerBinding, "holder"> | null,
  viewer: BindingViewer,
): boolean {
  return (
    viewer.can_manage ||
    ownerPrincipalId === viewer.principal_id ||
    (binding !== null &&
      viewer.run_id != null &&
      binding.holder.run_id === viewer.run_id)
  );
}

export function summarizeBinding(binding: ConsumerBinding) {
  return {
    consumer_binding_id: binding.consumer_binding_id,
    agent_id: binding.agent_id,
    binding_epoch: binding.binding_epoch,
    state: binding.state,
    mechanism: binding.mechanism,
    lease_expires_at: binding.lease_expires_at,
  };
}

export type CapabilityState =
  | "reported-supported"
  | "reported-unsupported"
  | "not-reported";

/** An absent capability key means the adapter did not report it, not "no". */
export function capabilityState(
  report: CapabilityReport | null | undefined,
  key: string,
): CapabilityState {
  const value = report?.capabilities[key];
  if (value === undefined) return "not-reported";
  return value ? "reported-supported" : "reported-unsupported";
}

export interface ObservationInput {
  binding: Pick<
    ConsumerBinding,
    "state" | "binding_epoch" | "lease_expires_at" | "updated_at"
  >;
  detail: "full" | "redacted";
  agent_epoch: number;
  authority: RuntimeAuthority;
  presence: RuntimePresenceObservation;
}

function leaseValid(authority: RuntimeAuthority, nowMs: number) {
  return (
    authority.source === "run" &&
    authority.run_state === "active" &&
    authority.enrollment_revoked !== true &&
    authority.lease_expires_at !== null &&
    authority.lease_expires_at * 1000 > nowMs
  );
}

/**
 * Derive mailbox occupancy and host liveness from authority facts. The result
 * describes who may consume the mailbox; it never describes task progress.
 * Leases are Unix seconds and the deadline is exclusive, as on the server.
 */
export function deriveObservation(
  input: ObservationInput,
  nowMs: number,
): RuntimeObservation {
  const { authority, binding, presence } = input;
  const reasons: RuntimeObservationReason[] = [];
  const deadlines: number[] = [];
  let lifecycle: RuntimeObservation["lifecycle"];
  if (binding.state !== "active") {
    lifecycle = binding.state;
    if (binding.state === "replaced" && leaseValid(authority, nowMs))
      reasons.push("replaced-run-still-active");
  } else if (binding.binding_epoch !== input.agent_epoch) {
    lifecycle = "unknown";
    reasons.push("epoch-mismatch");
  } else if (authority.source !== "run") {
    // A DO snapshot alone can never prove the occupant still holds authority.
    lifecycle = "unknown";
    reasons.push(authority.source);
  } else if (authority.run_state === "closed") {
    lifecycle = "expired";
    reasons.push("run-closed");
  } else if (authority.run_state === "revoked") {
    lifecycle = "expired";
    reasons.push("run-revoked");
  } else if (authority.run_state !== "active") {
    lifecycle = "unknown";
  } else if (authority.enrollment_revoked === true) {
    lifecycle = "expired";
    reasons.push("host-enrollment-revoked");
  } else if (
    authority.lease_expires_at === null ||
    authority.lease_expires_at * 1000 <= nowMs
  ) {
    lifecycle = "expired";
    reasons.push("run-lease-lapsed");
  } else {
    lifecycle = "attached";
    deadlines.push(authority.lease_expires_at * 1000);
  }

  const valid = leaseValid(authority, nowMs);
  let host_liveness: RuntimeHostLiveness = "unknown";
  let liveness_basis: RuntimeObservation["liveness_basis"] = "none";
  if (presence.status === "reported") {
    liveness_basis = "presence";
    const freshUntil = presence.last_seen + RUNTIME_PRESENCE_TTL_MS;
    if (freshUntil > nowMs) {
      host_liveness = "online";
      deadlines.push(freshUntil);
    } else host_liveness = valid ? "stale" : "offline";
  } else if (authority.source === "run") {
    liveness_basis = "run-lease";
    host_liveness = valid ? "online" : "offline";
    if (valid && authority.lease_expires_at !== null)
      deadlines.push(authority.lease_expires_at * 1000);
  }

  const observed = [
    binding.updated_at,
    presence.status === "reported" ? presence.last_seen : null,
  ].filter((value): value is number => value !== null);
  return {
    lifecycle,
    detail: input.detail,
    host_liveness,
    liveness_basis,
    reasons,
    last_observed_at: observed.length ? Math.max(...observed) : null,
    changes_at: deadlines.length ? Math.min(...deadlines) : null,
  };
}

/** Why a mailbox occupant needs a person's attention. */
export type RuntimeAttention =
  | "mailbox-expired"
  | "mailbox-unknown"
  | "host-offline"
  | "host-stale";

/**
 * The attention rule for one observed occupant: its authority lapsed, could
 * not be confirmed, or its host stopped reporting while it still holds the
 * mailbox. An unreachable run store is a source outage reported separately,
 * not evidence about the occupant, so it never counts here.
 */
export function runtimeAttention(
  observation: RuntimeObservation,
): RuntimeAttention | null {
  const { lifecycle, host_liveness, reasons } = observation;
  if (lifecycle === "expired") return "mailbox-expired";
  if (lifecycle === "unknown")
    return reasons.includes("run-source-unavailable")
      ? null
      : "mailbox-unknown";
  if (lifecycle === "attached" && host_liveness === "offline")
    return "host-offline";
  if (lifecycle === "attached" && host_liveness === "stale")
    return "host-stale";
  return null;
}

export const UNSUPPORTED_HOST_COMMAND = {
  supported: false,
  reason: "no-host-adapter-command",
} as const;

export function deriveReleaseCommand(
  current: {
    binding: Pick<
      ConsumerBinding,
      "state" | "binding_epoch" | "consumer_binding_id"
    >;
    release_authorized: boolean;
  } | null,
  attachAllowed: boolean,
): RuntimeCommands["release"] {
  const active = current?.binding.state === "active" ? current : null;
  const denied_reason = !active
    ? "no-active-binding"
    : !attachAllowed
      ? "capability-missing"
      : !active.release_authorized
        ? "permission-denied"
        : null;
  return {
    supported: true,
    allowed: denied_reason === null,
    expected_epoch: active?.binding.binding_epoch ?? null,
    consumer_binding_id: active?.binding.consumer_binding_id ?? null,
    denied_reason,
  };
}

/** Run as stored in D1. `state` is the raw column, not lease-derived. */
export interface RuntimeRunRecord {
  run_id: string;
  run_role: "acting" | "relay";
  enrollment_id: string | null;
  workload_binding_id: string | null;
  principal_id: string;
  participant_id: string;
  state: string;
  lease_expires_at: number;
  created_at: number;
}

export interface RuntimeEnrollmentRecord {
  enrollment_id: string;
  installation_id: string;
  name: string;
  kind: "personal" | "shared";
  sponsor_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

export type Settled<T> = { status: "ok"; value: T } | { status: "unavailable" };

/** Same visibility as `GET runtime/runs` and `GET runtime/enrollments`. */
export type RuntimeVisibilityScope =
  | { kind: "all" }
  | { kind: "sponsor"; principal_id: string }
  | { kind: "enrollment"; enrollment_id: string }
  | { kind: "none" };

export interface AssembleRuntimeViewInput {
  server_now: number;
  page: AgentRuntimePage;
  runs: Settled<RuntimeRunRecord[]>;
  enrollments: Settled<RuntimeEnrollmentRecord[]>;
  scope: RuntimeVisibilityScope;
  presence_allowed: boolean;
  attach_allowed: boolean;
  next_cursor: string | null;
}

type PageOccupant = NonNullable<AgentRuntimePage["rows"][number]["previous"]>;

const RUN_STATES = new Set(["active", "closed", "revoked"]);

/**
 * Join DO bindings with D1 runs and enrollments. This is the only place the
 * projection removes fields: anything a viewer may not see is replaced by an
 * explicit `redacted` marker, and anything a source could not answer becomes
 * `unknown` rather than empty.
 */
export function assembleRuntimeView(
  input: AssembleRuntimeViewInput,
): RuntimeViewResponse {
  const runs =
    input.runs.status === "ok"
      ? new Map(input.runs.value.map((run) => [run.run_id, run]))
      : null;
  const enrollments =
    input.enrollments.status === "ok"
      ? new Map(input.enrollments.value.map((row) => [row.enrollment_id, row]))
      : null;
  const scope = input.scope;

  // undefined = cannot decide because enrollments are unavailable.
  const enrollmentVisible = (id: string | null): boolean | undefined => {
    if (scope.kind === "all") return true;
    if (!id) return false;
    if (scope.kind === "enrollment") return scope.enrollment_id === id;
    if (scope.kind === "sponsor") {
      if (!enrollments) return undefined;
      return enrollments.get(id)?.sponsor_id === scope.principal_id;
    }
    return false;
  };

  const authorityFor = (binding: ConsumerBinding): RuntimeAuthority => {
    const snapshot = {
      run_state: "unknown",
      lease_expires_at: binding.lease_expires_at,
      enrollment_revoked: null,
    } as const;
    if (!runs) return { source: "run-source-unavailable", ...snapshot };
    const run = runs.get(binding.holder.run_id);
    if (!run) return { source: "run-not-found", ...snapshot };
    const enrollment = run.enrollment_id
      ? enrollments?.get(run.enrollment_id)
      : undefined;
    return {
      source: "run",
      run_state: RUN_STATES.has(run.state)
        ? (run.state as "active" | "closed" | "revoked")
        : "unknown",
      lease_expires_at: run.lease_expires_at,
      enrollment_revoked:
        run.enrollment_id && enrollments
          ? enrollment
            ? enrollment.revoked_at !== null
            : null
          : null,
    };
  };

  const runFor = (
    binding: ConsumerBinding,
    full: boolean,
  ): RuntimeRunObservation => {
    if (!full) return { status: "redacted" };
    const visible = enrollmentVisible(binding.holder.enrollment_id);
    if (visible === false) return { status: "redacted" };
    if (!runs || visible === undefined)
      return { status: "unknown", reason: "source-unavailable" };
    const run = runs.get(binding.holder.run_id);
    if (!run || !RUN_STATES.has(run.state))
      return { status: "unknown", reason: "not-found" };
    return {
      status: "visible",
      run_id: run.run_id,
      run_role: run.run_role,
      enrollment_id: run.enrollment_id,
      workload_binding_id: run.workload_binding_id,
      principal_id: run.principal_id,
      participant_id: run.participant_id,
      state: run.state as "active" | "closed" | "revoked",
      lease_expires_at: run.lease_expires_at,
      created_at: run.created_at,
    };
  };

  const hostFor = (
    binding: ConsumerBinding,
    full: boolean,
  ): RuntimeHostObservation => {
    if (!full) return { status: "redacted" };
    const id = binding.holder.enrollment_id;
    if (!id) {
      const workload = binding.holder.workload_binding_id;
      if (workload && scope.kind === "all")
        return { status: "workload", workload_binding_id: workload };
      return { status: "redacted" };
    }
    const visible = enrollmentVisible(id);
    if (visible === false) return { status: "redacted" };
    if (!enrollments || visible === undefined)
      return { status: "unknown", reason: "source-unavailable" };
    const row = enrollments.get(id);
    if (!row) return { status: "unknown", reason: "not-found" };
    return {
      status: "enrollment",
      enrollment_id: row.enrollment_id,
      installation_id: row.installation_id,
      name: row.name,
      kind: row.kind,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    };
  };

  const presenceFor = (
    occupant: PageOccupant,
    full: boolean,
  ): RuntimePresenceObservation => {
    if (!input.presence_allowed) return { status: "forbidden" };
    if (!full) return { status: "redacted" };
    if (!occupant.presence) return { status: "not-reported" };
    return {
      status: "reported",
      last_seen: occupant.presence.last_seen,
      active:
        occupant.presence.last_seen + RUNTIME_PRESENCE_TTL_MS >
        input.server_now,
      environment: occupant.presence.environment,
    };
  };

  const occupantFor = (
    occupant: PageOccupant,
    agentEpoch: number,
  ): RuntimeOccupant => {
    const full = occupant.detail === "full";
    const binding: RuntimeBinding = full
      ? { ...occupant.binding, detail: "full" }
      : {
          ...summarizeBinding(occupant.binding),
          updated_at: occupant.binding.updated_at,
          detail: "redacted",
        };
    const authority = authorityFor(occupant.binding);
    const presence = presenceFor(occupant, full);
    return {
      binding,
      authority,
      run: runFor(occupant.binding, full),
      host: hostFor(occupant.binding, full),
      presence,
      observation: deriveObservation(
        {
          binding: occupant.binding,
          detail: occupant.detail,
          agent_epoch: agentEpoch,
          authority,
          presence,
        },
        input.server_now,
      ),
    };
  };

  const rows: RuntimeViewRow[] = input.page.rows.map((row) => ({
    agent: {
      id: row.agent.id,
      name: row.agent.name,
      binding_epoch: row.agent.binding_epoch,
    },
    current: row.current
      ? occupantFor(row.current, row.agent.binding_epoch)
      : null,
    previous: row.previous
      ? occupantFor(row.previous, row.agent.binding_epoch)
      : null,
    work_attempt: null,
    commands: {
      release: deriveReleaseCommand(row.current, input.attach_allowed),
      reconnect: UNSUPPORTED_HOST_COMMAND,
      stop: UNSUPPORTED_HOST_COMMAND,
    },
  }));

  return {
    ok: true,
    server_now: input.server_now,
    sources: {
      agents: "ok",
      runs: input.runs.status,
      enrollments: input.enrollments.status,
      presence: input.presence_allowed ? "ok" : "forbidden",
    },
    rows,
    next_cursor: input.next_cursor,
  };
}
