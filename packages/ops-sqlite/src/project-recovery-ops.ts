import { ProjectRecoveryContextSchema } from "@tila/schemas";
import { eq } from "drizzle-orm";
import { appendJournal } from "./journal-ops";
import type { ProjectDatabase } from "./queue-internals";
import * as schema from "./schema";

export function context(db: ProjectDatabase) {
  const row = db.select().from(schema.projectTransferState).get();
  return row?.recovery_context
    ? ProjectRecoveryContextSchema.parse(JSON.parse(row.recovery_context))
    : null;
}

/** Called inside the same transaction as promotion of the export lock. */
export function bind(db: ProjectDatabase, value: unknown): void {
  const parsed = ProjectRecoveryContextSchema.parse(value);
  const state = db.select().from(schema.projectTransferState).get();
  if (
    !state ||
    state.owner !== "infra" ||
    state.archive_digest !== parsed.archive_digest ||
    state.safety_archive !== parsed.safety_archive
  )
    throw new Error("Recovery context does not match the transfer");
  db.update(schema.projectTransferState)
    .set({ recovery_context: JSON.stringify(parsed) })
    .where(eq(schema.projectTransferState.singleton, 1))
    .run();
}

export function receipt(db: ProjectDatabase, operationId: string) {
  return (
    db
      .select()
      .from(schema.projectRecoveryReceipts)
      .where(eq(schema.projectRecoveryReceipts.operation_id, operationId))
      .get() ?? null
  );
}

/** Receipt and audit survive snapshot replacement; finish before unlocking. */
export function complete(db: ProjectDatabase, operationId: string): void {
  const recovery = context(db);
  if (!recovery) return;
  const state = db.select().from(schema.projectTransferState).get();
  if (!state || state.session_id !== operationId || !state.archive_digest)
    throw new Error("Recovery operation does not match the transfer");
  const archiveDigest = state.archive_digest;
  db.transaction((tx) => {
    tx.update(schema.projectTransferState)
      .set({ applying: 1 })
      .where(eq(schema.projectTransferState.singleton, 1))
      .run();
    tx.insert(schema.projectRecoveryReceipts)
      .values({
        operation_id: operationId,
        mode: state.mode,
        archive_digest: archiveDigest,
        context: JSON.stringify(recovery),
        completed_at: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    appendJournal(tx, {
      kind: "project.restored",
      resource: "project",
      actor: "infra",
      principalId: "infra",
      participantId: operationId,
      environment: {},
      data: {
        operation_id: operationId,
        mode: state.mode,
        checkpoint_id: recovery.checkpoint.id,
        requested_at: recovery.requested_at,
        snapshot_at:
          state.mode === "rollback"
            ? (recovery.safety_snapshot_at ?? null)
            : recovery.checkpoint.snapshot_at,
        archive_digest: state.archive_digest,
        policy: recovery.policy,
      },
    });
    tx.update(schema.projectTransferState)
      .set({ applying: 0 })
      .where(eq(schema.projectTransferState.singleton, 1))
      .run();
  });
}
