type ProcessChecks = Pick<
  typeof import("@tila/client-lifecycle"),
  "processIdentity" | "processAlive"
>;

/**
 * These wiring fixtures use the executing Vitest worker as their session owner.
 * Its PID/start identity cannot change while it runs this code. Measure it once
 * instead of spawning ps at every reconciliation boundary under parallel load.
 * Keep start-identity comparisons and real probes for all other processes.
 * herdr.test.ts and discovery.test.ts retain the unmocked OS integration checks.
 */
export function workerProcessAlive(
  checks: ProcessChecks,
): ProcessChecks["processAlive"] {
  const self = checks.processIdentity(process.pid);
  if (!self || self.pid !== process.pid)
    throw new Error("Fixture worker process identity unavailable");
  const { pid, started } = self;
  return (owner) =>
    owner?.pid === pid ? owner.started === started : checks.processAlive(owner);
}
