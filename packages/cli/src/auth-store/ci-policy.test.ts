import { describe, expect, it } from "vitest";
import { evaluateCiPolicy } from "./ci-policy.js";
import type { InstanceCandidate, ResolverEnv } from "./resolver-types.js";

const homeCandidate: InstanceCandidate = {
  worker_url: "https://acme.dev",
  instance_key: "acme-prod" as InstanceCandidate["instance_key"],
  inlineToken: false,
};

const inlineCandidate: InstanceCandidate = {
  worker_url: "https://acme.dev",
  instance_key: null,
  inlineToken: true,
};

function env(overrides: Partial<ResolverEnv> = {}): ResolverEnv {
  return { isCI: false, isTTY: true, tilaHomeOverridden: false, ...overrides };
}

describe("evaluateCiPolicy (CI fail-closed — mandatory negative tests)", () => {
  it("allows inline tokens even under CI", () => {
    expect(evaluateCiPolicy(env({ isCI: true }), inlineCandidate)).toBeNull();
  });

  it("imposes no restriction in an interactive non-CI environment", () => {
    expect(evaluateCiPolicy(env(), homeCandidate)).toBeNull();
  });

  it("disables home-store credential reads under CI", () => {
    expect(evaluateCiPolicy(env({ isCI: true }), homeCandidate)).toEqual({
      kind: "ci-home-store-disabled",
    });
  });

  it("disables home-store credential reads under non-TTY (even without CI)", () => {
    expect(evaluateCiPolicy(env({ isTTY: false }), homeCandidate)).toEqual({
      kind: "ci-home-store-disabled",
    });
  });

  it("treats an overridden TILA_HOME under CI as untrusted (planted-registry defense)", () => {
    expect(
      evaluateCiPolicy(
        env({ isCI: true, tilaHomeOverridden: true }),
        homeCandidate,
      ),
    ).toEqual({ kind: "ci-tila-home-untrusted" });
  });

  it("does not treat an overridden TILA_HOME as untrusted outside CI", () => {
    // non-TTY interactive override falls back to the generic disable, not the
    // CI-specific untrusted decision.
    expect(
      evaluateCiPolicy(
        env({ isCI: false, isTTY: false, tilaHomeOverridden: true }),
        homeCandidate,
      ),
    ).toEqual({ kind: "ci-home-store-disabled" });
  });
});
