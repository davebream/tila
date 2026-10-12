/**
 * CI fail-closed gate (WI-J2).
 *
 * Under CI or a non-TTY environment, ambient credential sources are deny-by-
 * default. This gate runs in the resolver BEFORE `evaluateTrust`, so a CI
 * restriction can never be overridden by a (possibly planted) trusted registry.
 *
 * Disabled in CI/non-TTY (design §C4):
 *   (a) home-store keychain credential reads
 *   (b) lazy-promotion registry writes (the resolver never writes on a read path)
 *   (c) ambient GITHUB_TOKEN / `gh auth token` consumption (gated at the CLI site)
 *   (d) an overridden TILA_HOME under CI ⇒ the home registry is untrusted
 *
 * Allowed in CI: explicit --token / TILA_TOKEN / TILA_CONFIG, plus the
 * sanctioned GitHub Actions OIDC exchange (handled at the CLI site).
 */

import type {
  InstanceCandidate,
  ResolverEnv,
  TrustDecision,
} from "./resolver-types.js";

/**
 * Returns a CI-disabling decision for a home-store candidate under CI/non-TTY,
 * or `null` when CI imposes no restriction (inline tokens, or interactive use).
 */
export function evaluateCiPolicy(
  env: ResolverEnv,
  candidate: InstanceCandidate,
): TrustDecision | null {
  // Inline explicit tokens are always allowed — explicit and ephemeral.
  if (candidate.inlineToken) {
    return null;
  }

  const unattended = env.isCI || !env.isTTY;
  if (!unattended) {
    return null;
  }

  // (d) overridden TILA_HOME under CI ⇒ the home registry cannot be trusted,
  // regardless of what a (possibly planted) instances.toml claims.
  if (env.isCI && env.tilaHomeOverridden) {
    return { kind: "ci-tila-home-untrusted" };
  }

  // (a) home-store credential reads are disabled under CI / non-TTY.
  return { kind: "ci-home-store-disabled" };
}
