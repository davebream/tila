import { QueueRetryPolicySchema } from "@tila/schemas";
import { eq } from "drizzle-orm";
import * as attempts from "../src/attempt-ops";
import { create } from "../src/entity-ops";
import type { RequestOrigin } from "../src/journal-ops";
import type { ProjectDatabase } from "../src/queue-internals";
import * as schema from "../src/schema";
import { applySchema } from "../src/schema-ops";
import { lifecycleDefinition } from "./readiness-fixture";

export const attemptOrigin: RequestOrigin = {
  principalId: "worker",
  participantId: "worker-process",
  actor: "worker",
  environment: { machine: "host" },
};
export function seedAttempt(
  db: ProjectDatabase,
  id = "task",
  now = Date.now(),
  assigner: string | null = null,
) {
  if (!db.select().from(schema.schemaHistory).get())
    applySchema(db, lifecycleDefinition, "test");
  create(
    db,
    { id, type: "issue", data: { phase: "todo" }, created_by: "test" },
    1,
    attemptOrigin,
  );
  db.insert(schema.queueEntries)
    .values({
      id: `entry-${id}`,
      task_id: id,
      state: "queued",
      enqueue_order: now,
      required_capabilities: [],
      retry_policy: QueueRetryPolicySchema.parse({}),
      available_at: now,
      created_at: now,
      updated_at: now,
      enrolled_by_principal: assigner,
      enrolled_by_participant: assigner && `${assigner}-process`,
    })
    .run();
  const entry = db
    .select()
    .from(schema.queueEntries)
    .where(eq(schema.queueEntries.id, `entry-${id}`))
    .get();
  if (!entry) throw new Error("Missing fixture entry");
  return db.transaction((tx) =>
    attempts.reserveInTransaction(tx, entry, attemptOrigin, 60_000, now),
  );
}
export function authority(
  attempt: { id: string; revision: number; fence: number },
  key: string = crypto.randomUUID(),
) {
  return {
    idempotency_key: key,
    expected_revision: attempt.revision,
    fence: attempt.fence,
  };
}
