import { and, eq, inArray } from "drizzle-orm";
import { resolveCurrentSchema } from "./constraint-ops";
import { resolveEntityReference } from "./fence-ops";
import type { RequestOrigin } from "./journal-ops";
import { type ProjectDatabase, QueueError } from "./queue-internals";
import * as schema from "./schema";

export function isManagedTask(db: ProjectDatabase, id: string): boolean {
  return !!db
    .select({ id: schema.queueEntries.id })
    .from(schema.queueEntries)
    .where(
      and(
        eq(schema.queueEntries.task_id, id),
        inArray(schema.queueEntries.state, ["queued", "admitted"]),
      ),
    )
    .get();
}
export function assertUnmanagedClaim(
  db: ProjectDatabase,
  resource: string,
): void {
  const task = resolveEntityReference(db, resource);
  if (task && isManagedTask(db, task.id))
    throw new QueueError(
      "queue-managed-work",
      "Managed task claims are controlled by execution attempts",
    );
}
export function assertUnmanagedArchive(db: ProjectDatabase, id: string): void {
  if (isManagedTask(db, id))
    throw new QueueError(
      "queue-managed-work",
      "Withdraw or finish managed work before archiving its task",
    );
}
/** Returns true for ordinary content edits, which do not acquire execution authority. */
export function checkManagedWrite(
  db: ProjectDatabase,
  id: string,
  data: Record<string, unknown>,
  fence: number,
  origin: RequestOrigin,
  now: number,
  internalAttemptId?: string,
): boolean {
  if (!isManagedTask(db, id)) return false;
  const task = db
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, id))
    .get();
  const lifecycle =
    task && resolveCurrentSchema(db)?.work_units[task.type]?.lifecycle;
  if (!lifecycle)
    throw new QueueError(
      "queue-managed-work",
      "Managed lifecycle configuration requires repair before editing this task",
    );
  const existingData = JSON.parse(task.data) as Record<string, unknown>;
  if (
    !Object.hasOwn(data, lifecycle.field) ||
    data[lifecycle.field] === existingData[lifecycle.field]
  )
    return fence === 0;
  const attempt = db
    .select()
    .from(schema.workAttempts)
    .where(
      and(
        eq(schema.workAttempts.task_id, id),
        inArray(schema.workAttempts.state, ["reserved", "starting", "running"]),
      ),
    )
    .get();
  const claim =
    task &&
    db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.resource, `${task.type}:${id}`))
      .get();
  const owned =
    attempt &&
    attempt.fence === fence &&
    attempt.principal_id === origin.principalId &&
    attempt.participant_id === origin.participantId &&
    attempt.lease_expires_at !== null &&
    attempt.lease_expires_at > now &&
    claim &&
    claim.fence === fence &&
    claim.expires_at > now &&
    claim.principal_id === origin.principalId &&
    claim.participant_id === origin.participantId;
  const internal =
    internalAttemptId !== undefined && internalAttemptId === attempt?.id;
  if (
    !owned ||
    (!internal &&
      (attempt.accepted_at === null ||
        lifecycle.terminal.includes(String(data[lifecycle.field]))))
  )
    throw new QueueError(
      "queue-managed-work",
      "Lifecycle changes require current attempt authority; terminal status must be committed with its result",
    );
  return false;
}
