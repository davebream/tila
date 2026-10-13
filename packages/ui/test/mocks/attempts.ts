import type { WorkAttempt } from "@tila/schemas";

/** A running attempt on BUG-1 owned by another principal. */
export function attempt(overrides: Partial<WorkAttempt> = {}): WorkAttempt {
  return {
    id: "att-1",
    entry_id: "q1",
    task_id: "BUG-1",
    resource: "bug:BUG-1",
    principal_id: "github:example:9",
    participant_id: "worker-mac",
    state: "running",
    revision: 3,
    fence: 2,
    lease_expires_at: null,
    accepted_at: 1,
    session: null,
    checkpoint: null,
    cancellation_requested: false,
    suspension_requested: false,
    predecessor_id: null,
    outcome: null,
    created_at: 1,
    updated_at: 2,
    finished_at: null,
    revisions: null,
    ...overrides,
  };
}
