import type { InstanceKey, InstanceRecord } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import type { InstanceCandidate } from "./resolver-types.js";
import { evaluateTrust } from "./trust.js";

const key = (s: string) => s as InstanceKey;

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    instance_key: key("acme-prod"),
    worker_url: "https://acme.dev",
    instance_id_source: "server",
    trust: { trusted: true, trusted_at: 1_700_000_000_000 },
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<InstanceCandidate> = {},
): InstanceCandidate {
  return {
    worker_url: "https://acme.dev",
    instance_key: key("acme-prod"),
    inlineToken: false,
    ...overrides,
  };
}

describe("evaluateTrust", () => {
  it("trusts an explicit inline token regardless of registry", () => {
    expect(
      evaluateTrust(candidate({ inlineToken: true, instance_key: null }), null),
    ).toEqual({ kind: "trusted" });
  });

  it("returns unregistered when no record exists", () => {
    expect(evaluateTrust(candidate(), null)).toEqual({
      kind: "untrusted-needs-login",
      reason: "unregistered",
    });
  });

  it("returns not-trusted when the record is registered but untrusted", () => {
    const rec = record({ trust: { trusted: false, trusted_at: null } });
    expect(evaluateTrust(candidate(), rec)).toEqual({
      kind: "untrusted-needs-login",
      reason: "not-trusted",
    });
  });

  it("trusts a registered+trusted record whose worker_url matches", () => {
    expect(evaluateTrust(candidate(), record())).toEqual({ kind: "trusted" });
  });

  it("trusts despite trailing-slash / case / default-port differences", () => {
    const rec = record({ worker_url: "https://Acme.dev:443/" });
    expect(
      evaluateTrust(candidate({ worker_url: "https://acme.dev" }), rec),
    ).toEqual({ kind: "trusted" });
  });

  it("rejects a worker_url mismatch as a spoof (anti-spoofing cross-check)", () => {
    const rec = record({ worker_url: "https://acme.dev" });
    const decision = evaluateTrust(
      candidate({ worker_url: "https://evil.example" }),
      rec,
    );
    expect(decision.kind).toBe("spoof-worker-url-mismatch");
  });

  it("fails closed as spoof when a stored worker_url is unparseable", () => {
    const rec = record({ worker_url: "http://acme.dev" }); // http non-localhost → invalid
    const decision = evaluateTrust(
      candidate({ worker_url: "https://acme.dev" }),
      rec,
    );
    expect(decision.kind).toBe("spoof-worker-url-mismatch");
  });
});
