import { canonicalJson } from "@tila/schemas";
import type { JournalEventKind, QueueCommand } from "@tila/schemas";
import { eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";

export type ProjectDatabase = BaseSQLiteDatabase<
  "sync",
  unknown,
  typeof schema
>;
export type ProjectTransaction = Parameters<
  Parameters<ProjectDatabase["transaction"]>[0]
>[0];
export class QueueError extends Error {
  constructor(
    public readonly code:
      | "queue-managed-work"
      | "queue-not-found"
      | "queue-conflict"
      | "queue-authority-lost"
      | "queue-precondition"
      | "queue-invalid-state"
      | "queue-idempotency-conflict",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "QueueError";
  }
}
export function checkRevision(actual: number, expected: number): void {
  if (actual !== expected)
    throw new QueueError(
      "queue-precondition",
      `Expected revision ${expected}; current revision is ${actual}`,
    );
}
export function event(
  tx: ProjectTransaction,
  kind: JournalEventKind,
  resource: string,
  origin: RequestOrigin,
  data: Record<string, unknown>,
  fence?: number,
): void {
  appendJournal(tx, { kind, resource, ...origin, data, fence });
}
/** Durable command receipts have no time-based eviction. The caller must recompute grant validity. */
export function command<T extends Record<string, unknown>>(
  tx: ProjectTransaction,
  operation: string,
  origin: RequestOrigin,
  input: QueueCommand,
  run: () => T,
  links: { entry_id?: string; attempt_id?: string } = {},
  now = Date.now(),
): T {
  const key = canonicalJson([
    origin.principalId,
    origin.participantId,
    operation,
    input.idempotency_key,
  ]);
  const request = canonicalJson(input);
  const receipt = tx
    .select()
    .from(schema.queueOperationReceipts)
    .where(eq(schema.queueOperationReceipts.key, key))
    .get();
  if (receipt) {
    if (receipt.request !== request)
      throw new QueueError(
        "queue-idempotency-conflict",
        "Idempotency key already used for a different command",
      );
    return receipt.result as T;
  }
  const result = run();
  tx.insert(schema.queueOperationReceipts)
    .values({
      key,
      request,
      result,
      entry_id:
        links.entry_id ??
        (typeof result.entry_id === "string" ? result.entry_id : undefined),
      attempt_id:
        links.attempt_id ??
        (typeof result.attempt_id === "string" ? result.attempt_id : undefined),
      created_at: now,
    })
    .run();
  return result;
}
