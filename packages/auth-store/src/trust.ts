/**
 * The trust boundary — the load-bearing security control of WI-J2.
 *
 * `evaluateTrust` is the SINGLE path to a `trusted` decision. Every
 * credential-transmitting call site routes through it. It is a pure function so
 * every bypass scenario is a table-driven unit test.
 *
 * CI fail-closed is handled separately by `evaluateCiPolicy` (ci-policy.ts);
 * the resolver applies the CI gate BEFORE this function, so a CI restriction
 * can never be overridden here.
 */

import type { InstanceRecord } from "@tila/schemas";
import type { InstanceCandidate, TrustDecision } from "./resolver-types.js";
import { canonicalizeWorkerUrl } from "./worker-url.js";

/**
 * Decide whether a candidate instance may receive a credential.
 *
 * @param candidate the instance under evaluation
 * @param record    the registry record looked up by candidate.instance_key
 *                   (null when the key is unregistered or absent)
 */
export function evaluateTrust(
  candidate: InstanceCandidate,
  record: InstanceRecord | null,
): TrustDecision {
  // Rule 1: an explicit inline token is trusted for its own worker_url — the
  // user is presenting a credential directly; there is no home-store secret to
  // leak, and it is never re-associated with a registry instance.
  if (candidate.inlineToken) {
    return { kind: "trusted" };
  }

  // Rule 2: no registry record for this key.
  if (record === null) {
    return { kind: "untrusted-needs-login", reason: "unregistered" };
  }

  // Rule 3: registered but not yet trusted (no `tila auth login` gesture).
  if (record.trust.trusted !== true) {
    return { kind: "untrusted-needs-login", reason: "not-trusted" };
  }

  // Rule 4: worker_url cross-check (anti-spoofing). A cloned config claiming a
  // trusted instance_key but a different worker_url must NOT borrow the trust.
  let registered: string;
  let presented: string;
  try {
    registered = canonicalizeWorkerUrl(record.worker_url);
    presented = canonicalizeWorkerUrl(candidate.worker_url);
  } catch {
    // An unparseable/disallowed url on either side fails closed as a mismatch.
    return {
      kind: "spoof-worker-url-mismatch",
      registered: record.worker_url,
      presented: candidate.worker_url,
    };
  }

  if (registered !== presented) {
    return { kind: "spoof-worker-url-mismatch", registered, presented };
  }

  return { kind: "trusted" };
}
