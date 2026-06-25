/**
 * featurePending — standardized skip-gating wrapper for not-yet-built features.
 *
 * Usage:
 *   const fp = featurePending("WI-A", 131, "off-by-1000 boundary");
 *   fp.describe("off-by-1000 boundary", () => {
 *     fp.it("rejects timestamp off by 1000ms", async () => { ... });
 *   });
 *
 * The returned describe/it wrappers AUTOMATICALLY INJECT the
 * "FEATURE-PENDING(WI-x, #issue): " prefix into every title — callers do NOT
 * need to embed the marker manually. This guarantees the greppable marker
 * appears in every skipped title regardless of how callers phrase it, making
 * the grep-based un-skip workflow and contract AC-5/AC-10 robust.
 *
 *   grep -r 'FEATURE-PENDING(WI-A' packages/integration-tests/src/
 *
 * Returned wrappers are backed by describe.skip / it.skip — they never pass.
 */
import { describe, it } from "vitest";

/**
 * Returns a { describe, it } pair whose blocks are skip-gated and automatically
 * prefix every title with "FEATURE-PENDING(WI-x, #issue): <reason> — ".
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

  // Wrap describe.skip so every block title carries the greppable marker prefix.
  const wrappedDescribe = (title: string, fn: () => void) => {
    describe.skip(`${marker} — ${title}`, fn);
  };
  // Wrap it.skip so every case title carries the greppable marker prefix.
  const wrappedIt = (
    title: string,
    fn?: () => void | Promise<void>,
    timeout?: number,
  ) => {
    if (fn !== undefined) {
      it.skip(`${marker} — ${title}`, fn, timeout);
    } else {
      it.skip(`${marker} — ${title}`);
    }
  };

  return {
    describe: wrappedDescribe as unknown as typeof describe.skip,
    it: wrappedIt as unknown as typeof it.skip,
  };
}
