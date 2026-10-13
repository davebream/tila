import {
  type AgentRuntimePage,
  type ConsumerBinding,
  type RuntimeObservation,
  RuntimeObservationReasonSchema,
  RuntimeViewResponseSchema,
} from "@tila/schemas";
import { describe, expect, it } from "vitest";
import {
  type AssembleRuntimeViewInput,
  type RuntimeEnrollmentRecord,
  type RuntimeRunRecord,
  assembleRuntimeView,
  bindingDetailVisible,
  capabilityState,
  deriveObservation,
  deriveReleaseCommand,
  runtimeAttention,
  summarizeBinding,
} from "../src/runtime-observation";

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const ENROLLMENT = "00000000-0000-4000-8000-0000000000e1";
const RUN_A = "00000000-0000-4000-8000-0000000000a1";
const RUN_B = "00000000-0000-4000-8000-0000000000b1";

function bindingFixture(over: Partial<ConsumerBinding> = {}): ConsumerBinding {
  const run = over.holder?.run_id ?? RUN_A;
  return {
    consumer_binding_id: crypto.randomUUID(),
    agent_id: "worker",
    binding_epoch: 2,
    holder: {
      kind: "run",
      run_id: run,
      enrollment_id: ENROLLMENT,
      workload_binding_id: null,
    },
    principal_id: "enrollment:host",
    participant_id: `participant-${run}`,
    host_ref: ENROLLMENT,
    harness: "claude-code",
    native_session_ref: {
      host_ref: ENROLLMENT,
      harness: "claude-code",
      profile_id: "work",
      session_id: `session-${run}`,
    },
    profile: {
      profile_id: "work",
      profile_revision: 3,
      account_ref: "a".repeat(64),
      verification: "declared",
    },
    capability_report: {
      protocol: 1,
      adapter_version: "1.0.0",
      capabilities: {
        "io.tila/native-queue": true,
        "io.tila/urgent-steer": false,
      },
    },
    mechanism: "native-queue",
    attended: true,
    allow_idle_start: false,
    state: "active",
    lease_expires_at: NOW_S + 300,
    created_at: NOW - 10_000,
    updated_at: NOW - 5_000,
    ...over,
  };
}

function runFixture(over: Partial<RuntimeRunRecord> = {}): RuntimeRunRecord {
  return {
    run_id: RUN_A,
    run_role: "acting",
    enrollment_id: ENROLLMENT,
    workload_binding_id: null,
    principal_id: "enrollment:host",
    participant_id: `participant-${over.run_id ?? RUN_A}`,
    state: "active",
    lease_expires_at: NOW_S + 300,
    created_at: NOW_S - 100,
    ...over,
  };
}

const enrollment: RuntimeEnrollmentRecord = {
  enrollment_id: ENROLLMENT,
  installation_id: "00000000-0000-4000-8000-0000000000f1",
  name: "studio-mac",
  kind: "personal",
  sponsor_id: "github:1",
  created_at: NOW_S - 1000,
  revoked_at: null,
};

function pageWith(
  current: ConsumerBinding | null,
  previous: ConsumerBinding | null = null,
  detail: "full" | "redacted" = "full",
): AgentRuntimePage {
  const presence = (b: ConsumerBinding) => ({
    principal_id: b.principal_id,
    participant_id: b.participant_id,
    environment: { worktree: "/repo" },
    last_seen: NOW - 1_000,
  });
  return {
    rows: [
      {
        agent: { id: "worker", name: "Worker", binding_epoch: 2 },
        current: current
          ? {
              binding: current,
              detail,
              presence: presence(current),
              release_authorized: detail === "full",
            }
          : null,
        previous: previous
          ? { binding: previous, detail, presence: presence(previous) }
          : null,
      },
    ],
    next_after: null,
  };
}

function assemble(over: Partial<AssembleRuntimeViewInput> = {}) {
  return RuntimeViewResponseSchema.parse(
    assembleRuntimeView({
      server_now: NOW,
      page: pageWith(bindingFixture()),
      runs: { status: "ok", value: [runFixture()] },
      enrollments: { status: "ok", value: [enrollment] },
      scope: { kind: "all" },
      presence_allowed: true,
      attach_allowed: true,
      next_cursor: null,
      ...over,
    }),
  );
}

const runAuthority = {
  source: "run" as const,
  run_state: "active" as const,
  lease_expires_at: NOW_S + 300,
  enrollment_revoked: false,
};
const notReported = { status: "not-reported" as const };

describe("binding visibility", () => {
  const binding = bindingFixture();
  it.each([
    [{ principal_id: "x", can_manage: true }, true],
    [{ principal_id: "owner", can_manage: false }, true],
    [{ principal_id: "x", can_manage: false, run_id: RUN_A }, true],
    [{ principal_id: "x", can_manage: false, run_id: RUN_B }, false],
    [{ principal_id: "x", can_manage: false, run_id: null }, false],
  ])("viewer %o sees full detail: %s", (viewer, expected) => {
    expect(bindingDetailVisible("owner", binding, viewer)).toBe(expected);
  });

  it("summarizes to exactly the redacted binding keys", () => {
    expect(Object.keys(summarizeBinding(binding)).sort()).toEqual([
      "agent_id",
      "binding_epoch",
      "consumer_binding_id",
      "lease_expires_at",
      "mechanism",
      "state",
    ]);
  });
});

describe("deriveObservation", () => {
  const base = {
    binding: bindingFixture(),
    detail: "full" as const,
    agent_epoch: 2,
    authority: runAuthority,
    presence: notReported,
  };

  it("is attached until the exclusive lease deadline, then expired", () => {
    const attached = deriveObservation(base, NOW);
    expect(attached).toMatchObject({
      lifecycle: "attached",
      host_liveness: "online",
      liveness_basis: "run-lease",
      changes_at: (NOW_S + 300) * 1000,
    });
    expect(deriveObservation(base, (NOW_S + 300) * 1000)).toMatchObject({
      lifecycle: "expired",
      reasons: ["run-lease-lapsed"],
      host_liveness: "offline",
    });
  });

  it("trusts the D1 run lease over the binding snapshot", () => {
    const binding = bindingFixture({ lease_expires_at: NOW_S - 600 });
    expect(deriveObservation({ ...base, binding }, NOW).lifecycle).toBe(
      "attached",
    );
  });

  it.each([
    [{ run_state: "closed" as const }, "run-closed"],
    [{ run_state: "revoked" as const }, "run-revoked"],
    [{ enrollment_revoked: true }, "host-enrollment-revoked"],
  ])("expires when D1 authority ended (%o)", (over, reason) => {
    expect(
      deriveObservation(
        { ...base, authority: { ...runAuthority, ...over } },
        NOW,
      ),
    ).toMatchObject({ lifecycle: "expired", reasons: [reason] });
  });

  it.each(["run-source-unavailable", "run-not-found"] as const)(
    "never reports attached from a DO snapshot (%s)",
    (source) => {
      const observation = deriveObservation(
        {
          ...base,
          authority: {
            source,
            run_state: "unknown",
            lease_expires_at: NOW_S + 300,
            enrollment_revoked: null,
          },
        },
        NOW,
      );
      expect(observation).toMatchObject({
        lifecycle: "unknown",
        reasons: [source],
        host_liveness: "unknown",
      });
    },
  );

  it("keeps terminal binding states without D1 and flags live replaced runs", () => {
    for (const state of ["released", "expired"] as const)
      expect(
        deriveObservation({ ...base, binding: bindingFixture({ state }) }, NOW),
      ).toMatchObject({ lifecycle: state, reasons: [] });
    expect(
      deriveObservation(
        { ...base, binding: bindingFixture({ state: "replaced" }) },
        NOW,
      ),
    ).toMatchObject({
      lifecycle: "replaced",
      reasons: ["replaced-run-still-active"],
    });
  });

  it("reports an epoch mismatch as unknown", () => {
    expect(deriveObservation({ ...base, agent_epoch: 3 }, NOW)).toMatchObject({
      lifecycle: "unknown",
      reasons: ["epoch-mismatch"],
    });
  });

  it("separates host liveness from occupancy", () => {
    const reported = (last_seen: number) => ({
      status: "reported" as const,
      last_seen,
      active: true,
      environment: {},
    });
    expect(
      deriveObservation({ ...base, presence: reported(NOW - 1_000) }, NOW),
    ).toMatchObject({
      lifecycle: "attached",
      host_liveness: "online",
      liveness_basis: "presence",
      changes_at: NOW - 1_000 + 60_000,
      last_observed_at: NOW - 1_000,
    });
    expect(
      deriveObservation({ ...base, presence: reported(NOW - 120_000) }, NOW),
    ).toMatchObject({ lifecycle: "attached", host_liveness: "stale" });
    expect(
      deriveObservation(
        {
          ...base,
          presence: reported(NOW - 120_000),
          authority: { ...runAuthority, lease_expires_at: NOW_S - 1 },
        },
        NOW,
      ),
    ).toMatchObject({ lifecycle: "expired", host_liveness: "offline" });
    expect(
      deriveObservation(
        {
          ...base,
          presence: reported(NOW - 1_000),
          authority: { ...runAuthority, run_state: "closed" },
        },
        NOW,
      ),
    ).toMatchObject({ lifecycle: "expired", host_liveness: "online" });
  });

  it("never uses task-progress or verification wording", () => {
    for (const value of RuntimeObservationReasonSchema.options)
      expect(value).not.toMatch(/complete|idle|done|verified/);
  });
});

describe("runtimeAttention", () => {
  const observation = (
    over: Partial<RuntimeObservation> = {},
  ): RuntimeObservation => ({
    lifecycle: "attached",
    detail: "full",
    host_liveness: "online",
    liveness_basis: "run-lease",
    reasons: [],
    last_observed_at: NOW - 1_000,
    changes_at: NOW + 60_000,
    ...over,
  });

  it("flags an expired occupant as mailbox-expired", () => {
    expect(
      runtimeAttention(
        observation({
          lifecycle: "expired",
          host_liveness: "offline",
          reasons: ["run-lease-lapsed"],
        }),
      ),
    ).toBe("mailbox-expired");
  });

  it.each(["run-not-found", "epoch-mismatch"] as const)(
    "flags an occupant that cannot be confirmed (%s) as mailbox-unknown",
    (reason) => {
      expect(
        runtimeAttention(
          observation({
            lifecycle: "unknown",
            host_liveness: "unknown",
            liveness_basis: "none",
            reasons: [reason],
          }),
        ),
      ).toBe("mailbox-unknown");
    },
  );

  it("does not flag an occupant that is unknown only because runs are unavailable", () => {
    expect(
      runtimeAttention(
        observation({
          lifecycle: "unknown",
          host_liveness: "unknown",
          liveness_basis: "none",
          reasons: ["run-source-unavailable"],
        }),
      ),
    ).toBeNull();
  });

  it("flags an attached occupant whose host went offline", () => {
    expect(runtimeAttention(observation({ host_liveness: "offline" }))).toBe(
      "host-offline",
    );
  });

  it("flags an attached occupant whose host presence went stale", () => {
    expect(
      runtimeAttention(
        observation({ host_liveness: "stale", liveness_basis: "presence" }),
      ),
    ).toBe("host-stale");
  });

  it("does not flag an attached occupant with an online host", () => {
    expect(runtimeAttention(observation())).toBeNull();
  });

  it.each(["released", "replaced"] as const)(
    "does not flag a %s occupant",
    (lifecycle) => {
      expect(
        runtimeAttention(observation({ lifecycle, host_liveness: "offline" })),
      ).toBeNull();
    },
  );

  it("agrees with observations derived from D1 authority", () => {
    const base = {
      binding: bindingFixture(),
      detail: "full" as const,
      agent_epoch: 2,
      authority: runAuthority,
      presence: notReported,
    };
    expect(runtimeAttention(deriveObservation(base, NOW))).toBeNull();
    expect(
      runtimeAttention(deriveObservation(base, (NOW_S + 300) * 1000)),
    ).toBe("mailbox-expired");
    expect(
      runtimeAttention(
        deriveObservation(
          {
            ...base,
            presence: {
              status: "reported",
              last_seen: NOW - 120_000,
              active: false,
              environment: {},
            },
          },
          NOW,
        ),
      ),
    ).toBe("host-stale");
    expect(
      runtimeAttention(
        deriveObservation(
          {
            ...base,
            authority: {
              source: "run-source-unavailable",
              run_state: "unknown",
              lease_expires_at: NOW_S + 300,
              enrollment_revoked: null,
            },
          },
          NOW,
        ),
      ),
    ).toBeNull();
  });
});

describe("capability and command helpers", () => {
  it("distinguishes not reported from reported unsupported", () => {
    const report = bindingFixture().capability_report;
    expect(capabilityState(report, "io.tila/native-queue")).toBe(
      "reported-supported",
    );
    expect(capabilityState(report, "io.tila/urgent-steer")).toBe(
      "reported-unsupported",
    );
    expect(capabilityState(report, "io.tila/native-peer")).toBe("not-reported");
    expect(capabilityState(null, "io.tila/native-peer")).toBe("not-reported");
  });

  it("allows release only for an active binding with authority and capability", () => {
    const binding = bindingFixture();
    expect(
      deriveReleaseCommand({ binding, release_authorized: true }, true),
    ).toEqual({
      supported: true,
      allowed: true,
      expected_epoch: 2,
      consumer_binding_id: binding.consumer_binding_id,
      denied_reason: null,
    });
    expect(
      deriveReleaseCommand({ binding, release_authorized: true }, false)
        .denied_reason,
    ).toBe("capability-missing");
    expect(
      deriveReleaseCommand({ binding, release_authorized: false }, true)
        .denied_reason,
    ).toBe("permission-denied");
    expect(deriveReleaseCommand(null, true)).toMatchObject({
      allowed: false,
      expected_epoch: null,
      denied_reason: "no-active-binding",
    });
  });
});

describe("assembleRuntimeView", () => {
  it("projects full evidence for an authorized viewer", () => {
    const view = assemble();
    const row = view.rows[0];
    expect(row.work_attempt).toBeNull();
    expect(row.commands.reconnect).toEqual({
      supported: false,
      reason: "no-host-adapter-command",
    });
    expect(row.current).toMatchObject({
      binding: { detail: "full", profile: { verification: "declared" } },
      run: { status: "visible", run_id: RUN_A },
      host: { status: "enrollment", name: "studio-mac" },
      presence: { status: "reported", active: true },
      observation: { lifecycle: "attached", detail: "full" },
    });
  });

  it("leaks no identities through a redacted row but keeps its lifecycle", () => {
    const view = assemble({
      page: pageWith(bindingFixture(), null, "redacted"),
      runs: {
        status: "ok",
        value: [runFixture({ lease_expires_at: NOW_S - 10 })],
      },
    });
    const json = JSON.stringify(view);
    for (const secret of [
      RUN_A,
      `participant-${RUN_A}`,
      `session-${RUN_A}`,
      "a".repeat(64),
      "studio-mac",
      "enrollment:host",
      "/repo",
    ])
      expect(json).not.toContain(secret);
    expect(view.rows[0].current).toMatchObject({
      binding: { detail: "redacted" },
      run: { status: "redacted" },
      host: { status: "redacted" },
      presence: { status: "redacted" },
      observation: { lifecycle: "expired", detail: "redacted" },
    });
    expect(view.rows[0].commands.release.denied_reason).toBe(
      "permission-denied",
    );
  });

  it("degrades to unknown when D1 is unavailable and keeps terminal states", () => {
    const released = bindingFixture({
      state: "released",
      holder: {
        kind: "run",
        run_id: RUN_B,
        enrollment_id: ENROLLMENT,
        workload_binding_id: null,
      },
    });
    const view = assemble({
      page: pageWith(bindingFixture(), released),
      runs: { status: "unavailable" },
      enrollments: { status: "unavailable" },
    });
    expect(view.sources).toMatchObject({
      agents: "ok",
      runs: "unavailable",
      enrollments: "unavailable",
    });
    expect(view.rows[0].current).toMatchObject({
      run: { status: "unknown", reason: "source-unavailable" },
      host: { status: "unknown", reason: "source-unavailable" },
      observation: {
        lifecycle: "unknown",
        reasons: ["run-source-unavailable"],
      },
    });
    expect(view.rows[0].previous?.observation.lifecycle).toBe("released");
  });

  it("keeps two sessions in one directory distinct and shows the replaced run", () => {
    const old = bindingFixture({
      state: "replaced",
      binding_epoch: 1,
      holder: {
        kind: "run",
        run_id: RUN_B,
        enrollment_id: ENROLLMENT,
        workload_binding_id: null,
      },
      participant_id: `participant-${RUN_B}`,
      native_session_ref: {
        host_ref: ENROLLMENT,
        harness: "claude-code",
        profile_id: "work",
        session_id: `session-${RUN_B}`,
      },
    });
    const view = assemble({
      page: pageWith(bindingFixture(), old),
      runs: {
        status: "ok",
        value: [runFixture(), runFixture({ run_id: RUN_B })],
      },
    });
    const { current, previous } = view.rows[0];
    expect(
      current?.binding.detail === "full" &&
        current.binding.native_session_ref?.session_id,
    ).toBe(`session-${RUN_A}`);
    expect(
      previous?.binding.detail === "full" &&
        previous.binding.native_session_ref?.session_id,
    ).toBe(`session-${RUN_B}`);
    expect(previous?.observation).toMatchObject({
      lifecycle: "replaced",
      reasons: ["replaced-run-still-active"],
    });
    expect(view.rows[0].commands.release.expected_epoch).toBe(2);
  });

  it("applies sponsor and enrollment scopes to runs and hosts", () => {
    const sponsor = assemble({
      scope: { kind: "sponsor", principal_id: "github:2" },
    });
    expect(sponsor.rows[0].current).toMatchObject({
      run: { status: "redacted" },
      host: { status: "redacted" },
    });
    const own = assemble({
      scope: { kind: "sponsor", principal_id: "github:1" },
    });
    expect(own.rows[0].current?.run.status).toBe("visible");
    const enrollmentScope = assemble({
      scope: { kind: "enrollment", enrollment_id: ENROLLMENT },
    });
    expect(enrollmentScope.rows[0].current?.host.status).toBe("enrollment");
  });

  it("marks presence forbidden without presence:read", () => {
    const view = assemble({ presence_allowed: false });
    expect(view.sources.presence).toBe("forbidden");
    expect(view.rows[0].current?.presence).toEqual({ status: "forbidden" });
  });
});
