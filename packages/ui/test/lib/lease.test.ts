import {
  deriveBindingView,
  heartbeatFresh,
  leaseCountdown,
  leaseExpiryMs,
} from "@/lib/lease";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const summary = (state: string, lease: number) =>
  ({
    consumer_binding_id: crypto.randomUUID(),
    agent_id: "worker",
    binding_epoch: 1,
    state,
    mechanism: "poll",
    lease_expires_at: lease,
  }) as never;

describe("lease time boundary", () => {
  test("converts runtime seconds to milliseconds", () => {
    expect(leaseExpiryMs(1_000)).toBe(1_000_000);
  });

  test("attached before the deadline, expired at and after it", () => {
    const lease = NOW / 1000 + 300;
    const binding = summary("active", lease);
    expect(deriveBindingView(binding, NOW).kind).toBe("attached");
    expect(deriveBindingView(binding, NOW + 300_000 - 1).kind).toBe("attached");
    expect(deriveBindingView(binding, NOW + 300_000).kind).toBe("expired");
    expect(deriveBindingView(binding, NOW + 400_000).kind).toBe("expired");
  });

  test("a millisecond-scale value would be a 1970 date; seconds are not", () => {
    const view = deriveBindingView(summary("active", NOW / 1000 + 300), NOW);
    expect(view.kind === "attached" && view.expiresAtMs).toBe(NOW + 300_000);
  });

  test.each(["replaced", "released", "expired"] as const)(
    "reports a %s binding as that state, never attached",
    (state) => {
      expect(
        deriveBindingView(summary(state, NOW / 1000 + 300), NOW).kind,
      ).toBe(state);
    },
  );

  test("no binding", () => {
    expect(deriveBindingView(null, NOW)).toEqual({ kind: "none" });
  });

  test("flags the permission-redacted summary", () => {
    const view = deriveBindingView(summary("active", NOW / 1000 + 5), NOW);
    expect(view.kind !== "none" && view.redacted).toBe(true);
    const full = {
      ...(summary("active", NOW / 1000 + 5) as object),
      holder: {},
    };
    const fullView = deriveBindingView(full as never, NOW);
    expect(fullView.kind !== "none" && fullView.redacted).toBe(false);
  });

  test("countdown wording", () => {
    expect(leaseCountdown(NOW + 300_000, NOW)).toBe("in 5m");
    expect(leaseCountdown(NOW - 120_000, NOW)).toBe("2m ago");
  });

  test("heartbeat freshness needs the server flag and a recent last_seen", () => {
    expect(heartbeatFresh({ active: true, last_seen: NOW - 1_000 }, NOW)).toBe(
      true,
    );
    expect(heartbeatFresh({ active: true, last_seen: NOW - 61_000 }, NOW)).toBe(
      false,
    );
    expect(heartbeatFresh({ active: false, last_seen: NOW - 1_000 }, NOW)).toBe(
      false,
    );
  });
});
