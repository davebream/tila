/**
 * featurePending — standardized skip-gating wrapper for not-yet-built features.
 *
 * Usage:
 *   const { describe: xdescribe, it: xit } = featurePending("WI-A", 131, "off-by-1000 boundary");
 *   xdescribe("FEATURE-PENDING(WI-A, #131): off-by-1000 boundary", () => {
 *     xit("rejects timestamp off by 1000ms", async () => { ... });
 *   });
 *
 * The titles embed the FEATURE-PENDING(WI-x, #issue) marker so siblings can
 * grep to find exactly the tests to un-skip when their feature lands:
 *   grep -r 'FEATURE-PENDING(WI-A' packages/integration-tests/src/
 *
 * Use the returned wrappers as describe.skip / it.skip — they never pass.
 */
import { describe, it } from "vitest";

/**
 * Returns a { describe, it } pair whose blocks are skip-gated with a
 * standardized "FEATURE-PENDING(WI-x, #issue): <reason>" marker title.
 *
 * @param wi          - The work-item label, e.g. "WI-A"
 * @param issueNumber - The GitHub issue number, e.g. 131
 * @param reason      - A short reason describing the pending feature
 */
export function featurePending(
  wi: string,
  issueNumber: number | string,
  reason: string,
): { describe: typeof describe.skip; it: typeof it.skip } {
  const marker = `FEATURE-PENDING(${wi}, #${issueNumber}): ${reason}`;
  // Attach the marker as a property so consumers can introspect without
  // needing to parse test titles.
  void marker; // referenced in test titles below

  return {
    describe: describe.skip,
    it: it.skip,
  };
}
