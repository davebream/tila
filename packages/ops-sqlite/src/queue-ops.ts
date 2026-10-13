import {
  type QueueBlockReason,
  type QueueClaimCommand,
  QueueClaimCommandSchema,
  type QueueClaimResult,
  type QueueConfigureCommand,
  QueueConfigureCommandSchema,
  type QueueEditCommand,
  QueueEditCommandSchema,
  type QueueEnrollCommand,
  QueueEnrollCommandSchema,
  type QueueEntry,
  type QueueInspection,
  type QueueListQuery,
  QueueListQuerySchema,
  type QueuePolicy,
  type QueueRevisionCommand,
  QueueRevisionCommandSchema,
  type WorkAttempt,
} from "@tila/schemas";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import * as attempts from "./attempt-ops";
import { resolveCurrentSchema } from "./constraint-ops";
import type { RequestOrigin } from "./journal-ops";
import {
  type ProjectDatabase,
  QueueError,
  checkRevision,
  command,
  event,
} from "./queue-internals";
import {
  type ReadinessSnapshot,
  evaluateReadiness,
  readReadinessSnapshot,
} from "./ready-ops";
import * as schema from "./schema";

/** Resource permissions are supplied by the authenticated boundary, never capabilities. */
export type QueueTaskAccess = (taskId: string) => boolean;
const allTasks: QueueTaskAccess = () => true;
export function policy(db: ProjectDatabase): QueuePolicy {
  const row = db
    .select()
    .from(schema.queuePolicy)
    .where(eq(schema.queuePolicy.singleton, 1))
    .get();
  return {
    enabled: row?.enabled ?? false,
    paused: row?.paused ?? true,
    execution_limit: row?.execution_limit ?? null,
    wip_limit: row?.wip_limit ?? null,
    lease_ms: row?.lease_ms ?? 60_000,
    revision: row?.revision ?? 0,
  };
}
export function configure(
  db: ProjectDatabase,
  raw: QueueConfigureCommand,
  origin: RequestOrigin,
  canManage: boolean,
  now = Date.now(),
): QueuePolicy {
  if (!canManage)
    throw new QueueError(
      "queue-authority-lost",
      "Maintainer authority is required to configure dispatch",
    );
  const input = QueueConfigureCommandSchema.parse(raw);
  return db.transaction((tx) => {
    command(
      tx,
      "policy",
      origin,
      input,
      () => {
        const current = policy(tx);
        checkRevision(current.revision, input.expected_revision);
        const {
          idempotency_key: _key,
          expected_revision: _revision,
          ...patch
        } = input;
        const next = { ...current, revision: current.revision + 1 };
        if (patch.enabled !== undefined) next.enabled = patch.enabled;
        if (patch.paused !== undefined) next.paused = patch.paused;
        if (patch.execution_limit !== undefined)
          next.execution_limit = patch.execution_limit;
        if (patch.wip_limit !== undefined) next.wip_limit = patch.wip_limit;
        if (patch.lease_ms !== undefined) next.lease_ms = patch.lease_ms;
        if (next.enabled && next.execution_limit === null)
          throw new QueueError(
            "queue-precondition",
            "An explicit positive execution limit is required before enabling dispatch",
          );
        const previous = tx
          .select()
          .from(schema.queuePolicy)
          .where(eq(schema.queuePolicy.singleton, 1))
          .get();
        const row = {
          singleton: 1,
          ...next,
          revision_required:
            next.enabled || (previous?.revision_required ?? false),
        };
        tx.insert(schema.queuePolicy)
          .values(row)
          .onConflictDoUpdate({
            target: schema.queuePolicy.singleton,
            set: row,
          })
          .run();
        event(tx, "queue.policy_changed", "queue", origin, { policy: next });
        return { policy_revision: next.revision };
      },
      {},
      now,
    );
    return policy(tx);
  });
}
export function getEntry(db: ProjectDatabase, id: string): QueueEntry {
  const row = db
    .select()
    .from(schema.queueEntries)
    .where(eq(schema.queueEntries.id, id))
    .get();
  if (!row)
    throw new QueueError("queue-not-found", `Queue entry ${id} does not exist`);
  return row;
}
export function unfinishedEntry(
  db: ProjectDatabase,
  taskId: string,
): QueueEntry | undefined {
  return db
    .select()
    .from(schema.queueEntries)
    .where(
      and(
        eq(schema.queueEntries.task_id, taskId),
        inArray(schema.queueEntries.state, ["queued", "admitted"]),
      ),
    )
    .get();
}
export function enroll(
  db: ProjectDatabase,
  raw: QueueEnrollCommand,
  origin: RequestOrigin,
  now = Date.now(),
): QueueEntry {
  const input = QueueEnrollCommandSchema.parse(raw);
  return db.transaction((tx) => {
    const result = command(
      tx,
      "enroll",
      origin,
      input,
      () => {
        const task = tx
          .select()
          .from(schema.entities)
          .where(eq(schema.entities.id, input.task_id))
          .get();
        if (!task || task.archived)
          throw new QueueError(
            "queue-not-found",
            "A nonarchived task is required for enrollment",
          );
        if (!resolveCurrentSchema(tx)?.work_units[task.type]?.lifecycle)
          throw new QueueError(
            "queue-precondition",
            "Managed work requires explicit lifecycle metadata",
          );
        const existing = unfinishedEntry(tx, task.id);
        if (existing)
          throw new QueueError(
            "queue-conflict",
            `Task already has unfinished enrollment ${existing.id}`,
            { entry_id: existing.id },
          );
        const claim = tx
          .select()
          .from(schema.claims)
          .where(eq(schema.claims.resource, `${task.type}:${task.id}`))
          .get();
        if (claim && claim.expires_at > now)
          throw new QueueError(
            "queue-conflict",
            "Release the existing task claim before enrollment",
          );
        const nextOrder =
          tx
            .select({
              n: sql<number>`coalesce(max(${schema.queueEntries.enqueue_order}), 0) + 1`,
            })
            .from(schema.queueEntries)
            .get()?.n ?? 1;
        const id = crypto.randomUUID();
        tx.insert(schema.queueEntries)
          .values({
            id,
            task_id: task.id,
            state: "queued",
            priority: input.priority,
            enqueue_order: nextOrder,
            required_capabilities: [
              ...new Set(input.required_capabilities),
            ].sort(),
            target_principal: input.target_principal,
            retry_policy: input.retry_policy,
            available_at: now,
            created_at: now,
            updated_at: now,
            enrolled_by_principal: origin.principalId,
            enrolled_by_participant: origin.participantId,
          })
          .run();
        event(tx, "queue.enrolled", `${task.type}:${task.id}`, origin, {
          entry_id: id,
        });
        return { entry_id: id };
      },
      {},
      now,
    );
    return getEntry(tx, result.entry_id);
  });
}
/**
 * Enrollment changes belong to the assigner or a maintainer. Entries recorded
 * before the assigner was captured keep their original task-writer behavior.
 */
export function assertEntryControl(
  entry: QueueEntry,
  origin: RequestOrigin,
  canManage: boolean,
): void {
  if (
    canManage ||
    entry.enrolled_by_principal === null ||
    entry.enrolled_by_principal === origin.principalId
  )
    return;
  throw new QueueError(
    "queue-authority-lost",
    "Only the principal that enrolled this work or a maintainer can change it",
  );
}
export function edit(
  db: ProjectDatabase,
  id: string,
  raw: QueueEditCommand,
  origin: RequestOrigin,
  canManage = false,
  now = Date.now(),
): QueueEntry {
  const input = QueueEditCommandSchema.parse(raw);
  return db.transaction((tx) => {
    assertEntryControl(getEntry(tx, id), origin, canManage);
    command(
      tx,
      `entry-edit:${id}`,
      origin,
      input,
      () => {
        const entry = getEntry(tx, id);
        checkRevision(entry.revision, input.expected_revision);
        if (entry.state === "finished" || entry.state === "withdrawn")
          throw new QueueError(
            "queue-invalid-state",
            "Terminal enrollment cannot be edited",
          );
        const {
          idempotency_key: _key,
          expected_revision: _revision,
          ...patch
        } = input;
        tx.update(schema.queueEntries)
          .set({ ...patch, revision: entry.revision + 1, updated_at: now })
          .where(eq(schema.queueEntries.id, id))
          .run();
        event(tx, "queue.updated", entry.task_id, origin, {
          entry_id: id,
          ...patch,
        });
        return { entry_id: id };
      },
      { entry_id: id },
      now,
    );
    return getEntry(tx, id);
  });
}
export function withdraw(
  db: ProjectDatabase,
  id: string,
  raw: QueueRevisionCommand,
  origin: RequestOrigin,
  canManage = false,
  now = Date.now(),
): QueueEntry {
  const input = QueueRevisionCommandSchema.parse(raw);
  attempts.expire(db, now);
  return db.transaction((tx) => {
    assertEntryControl(getEntry(tx, id), origin, canManage);
    command(
      tx,
      `withdraw:${id}`,
      origin,
      input,
      () => {
        const entry = getEntry(tx, id);
        checkRevision(entry.revision, input.expected_revision);
        const reservation = tx
          .select()
          .from(schema.executionReservations)
          .where(eq(schema.executionReservations.task_id, entry.task_id))
          .get();
        if (entry.state !== "queued" || reservation?.execution_held)
          throw new QueueError(
            "queue-invalid-state",
            "Only backlog work can be withdrawn; cancel admitted execution explicitly",
          );
        tx.delete(schema.executionReservations)
          .where(eq(schema.executionReservations.task_id, entry.task_id))
          .run();
        tx.update(schema.queueEntries)
          .set({
            state: "withdrawn",
            revision: entry.revision + 1,
            updated_at: now,
          })
          .where(eq(schema.queueEntries.id, id))
          .run();
        event(tx, "queue.withdrawn", entry.task_id, origin, { entry_id: id });
        return { entry_id: id };
      },
      { entry_id: id },
      now,
    );
    return getEntry(tx, id);
  });
}
export function occupancy(db: ProjectDatabase): {
  execution: number;
  wip: number;
} {
  const row = db
    .select({
      execution: sql<number>`coalesce(sum(${schema.executionReservations.execution_held}), 0)`,
      wip: sql<number>`coalesce(sum(${schema.executionReservations.wip_held}), 0)`,
    })
    .from(schema.executionReservations)
    .get();
  return row ?? { execution: 0, wip: 0 };
}
function entryReasons(
  db: ProjectDatabase,
  entry: QueueEntry,
  snapshot: ReadinessSnapshot,
  now: number,
  origin?: RequestOrigin,
  capabilities?: string[],
): QueueBlockReason[] {
  const reasons: QueueBlockReason[] = [
    ...evaluateReadiness(snapshot, entry.task_id, true).reasons,
  ];
  const add = (code: QueueBlockReason["code"]) =>
    reasons.push({ code, resource: entry.task_id });
  if (entry.available_at > now) add("retry-backoff");
  if (
    origin &&
    entry.target_principal &&
    entry.target_principal !== origin.principalId
  )
    add("target-mismatch");
  if (
    capabilities &&
    entry.required_capabilities.some(
      (capability) => !capabilities.includes(capability),
    )
  )
    add("capability-mismatch");
  const task = snapshot.entities.get(entry.task_id);
  if (task) {
    const claim = db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.resource, `${task.type}:${task.id}`))
      .get();
    if (claim && claim.expires_at > now) add("live-claim");
  }
  const active = db
    .select({ id: schema.workAttempts.id })
    .from(schema.workAttempts)
    .where(
      and(
        eq(schema.workAttempts.task_id, entry.task_id),
        sql`${schema.workAttempts.state} != 'terminal'`,
      ),
    )
    .get();
  if (active) add("attempt-active");
  const reservation = db
    .select()
    .from(schema.executionReservations)
    .where(eq(schema.executionReservations.task_id, entry.task_id))
    .get();
  if (
    reservation &&
    (reservation.execution_held || reservation.entry_id !== entry.id)
  )
    add("execution-unresolved");
  return reasons;
}
const noGrantMessages = {
  disabled: "Managed dispatch is disabled",
  paused: "New execution grants are paused",
  empty: "No enrolled backlog work",
  blocked: "No eligible work matches this consumer",
  execution_capacity: "Execution capacity is occupied",
  wip_capacity: "Work-in-progress capacity is occupied",
} as const;
export function claimNext(
  db: ProjectDatabase,
  raw: QueueClaimCommand,
  origin: RequestOrigin,
  allowsTask: QueueTaskAccess = allTasks,
  now = Date.now(),
): QueueClaimResult {
  const input = QueueClaimCommandSchema.parse(raw);
  return db.transaction(
    (tx) => {
      attempts.expireInTransaction(tx, now);
      const result = command(
        tx,
        "claim-next",
        origin,
        input,
        () => {
          const current = policy(tx);
          const denied = (reason: keyof typeof noGrantMessages) => {
            event(tx, "queue.grant_denied", "queue", origin, {
              reason,
              policy_revision: current.revision,
            });
            return { reason, policy_revision: current.revision };
          };
          if (!current.enabled) return denied("disabled");
          if (current.paused) return denied("paused");
          const counts = occupancy(tx);
          if (
            current.execution_limit === null ||
            counts.execution >= current.execution_limit
          )
            return denied("execution_capacity");
          const entries = tx
            .select()
            .from(schema.queueEntries)
            .where(eq(schema.queueEntries.state, "queued"))
            .orderBy(
              desc(schema.queueEntries.priority),
              asc(schema.queueEntries.enqueue_order),
              asc(schema.queueEntries.id),
            )
            .all()
            .filter((entry) => allowsTask(entry.task_id));
          if (!entries.length) return denied("empty");
          const snapshot = readReadinessSnapshot(tx, now);
          let wipBlocked = false;
          for (const entry of entries) {
            if (
              input.types &&
              !input.types.includes(
                snapshot.entities.get(entry.task_id)?.type ?? "",
              )
            )
              continue;
            if (
              entryReasons(tx, entry, snapshot, now, origin, input.capabilities)
                .length
            )
              continue;
            const reservation = tx
              .select()
              .from(schema.executionReservations)
              .where(eq(schema.executionReservations.task_id, entry.task_id))
              .get();
            if (
              !reservation?.wip_held &&
              current.wip_limit !== null &&
              counts.wip >= current.wip_limit
            ) {
              wipBlocked = true;
              continue;
            }
            const predecessor = tx
              .select()
              .from(schema.workAttempts)
              .where(eq(schema.workAttempts.entry_id, entry.id))
              .orderBy(
                desc(schema.workAttempts.fence),
                desc(schema.workAttempts.created_at),
                desc(schema.workAttempts.id),
              )
              .get();
            const attempt = attempts.reserveInTransaction(
              tx,
              entry,
              origin,
              current.lease_ms,
              now,
              predecessor?.id,
            );
            return {
              attempt_id: attempt.id,
              fence: attempt.fence,
              entry_id: entry.id,
              policy_revision: current.revision,
            };
          }
          return denied(wipBlocked ? "wip_capacity" : "blocked");
        },
        {},
        now,
      );
      if ("attempt_id" in result) {
        const attempt = attempts.get(tx, result.attempt_id);
        if (!allowsTask(attempt.task_id))
          throw new QueueError(
            "queue-authority-lost",
            "Current resource permissions no longer allow this grant",
          );
        return {
          kind: "granted",
          entry: getEntry(tx, attempt.entry_id),
          ...attempts.view(tx, attempt.id, origin, now),
          grant_valid:
            result.fence === attempt.fence &&
            attempts.grantValid(tx, attempt, origin, now),
          policy_revision: result.policy_revision,
        };
      }
      return {
        kind: "no_grant",
        reason: result.reason,
        message: noGrantMessages[result.reason],
        policy_revision: result.policy_revision,
      };
    },
    { behavior: "immediate" },
  );
}
function group(
  entry: QueueEntry,
  attempt?: WorkAttempt,
): "backlog" | "active" | "suspended" | "uncertain" | "terminal" {
  if (entry.state === "finished" || entry.state === "withdrawn")
    return "terminal";
  if (entry.state === "queued") return "backlog";
  if (attempt?.state === "suspended" || attempt?.state === "resume_pending")
    return "suspended";
  if (attempt?.state === "uncertain") return "uncertain";
  return "active";
}
/**
 * A starting or running attempt past its execution lease. Expiry processing
 * later turns it uncertain; until then this is the scoped view of the
 * `expired_execution_leases` diagnostic.
 */
function leaseLapsed(attempt: WorkAttempt | undefined, now: number) {
  return (
    (attempt?.state === "starting" || attempt?.state === "running") &&
    attempt.lease_expires_at !== null &&
    attempt.lease_expires_at <= now
  );
}
/** Project-wide operational totals in the retained journal's last 24 hours. */
export function diagnostics(db: ProjectDatabase, now = Date.now()) {
  const since = now - 86_400_000;
  const rows = db
    .select({
      kind: schema.journal.kind,
      detail: sql<string>`CASE WHEN ${schema.journal.kind} = 'queue.grant_denied' THEN json_extract(${schema.journal.data}, '$.reason') WHEN ${schema.journal.kind} = 'attempt.finished' THEN json_extract(${schema.journal.data}, '$.outcome.status') ELSE '' END`,
      total: sql<number>`count(*)`,
    })
    .from(schema.journal)
    .where(
      and(
        gte(schema.journal.t, since),
        sql`${schema.journal.t} <= ${now}`,
        inArray(schema.journal.kind, [
          "queue.grant_denied",
          "attempt.expired",
          "attempt.uncertain",
          "attempt.rebound",
          "attempt.retried",
          "attempt.finished",
        ]),
      ),
    )
    .groupBy(schema.journal.kind, sql`2`)
    .all();
  const count = (kind: string) =>
    rows
      .filter((row) => row.kind === kind)
      .reduce((sum, row) => sum + row.total, 0);
  const expired =
    db
      .select({ total: sql<number>`count(*)` })
      .from(schema.workAttempts)
      .where(
        and(
          inArray(schema.workAttempts.state, ["starting", "running"]),
          sql`${schema.workAttempts.lease_expires_at} <= ${now}`,
        ),
      )
      .get()?.total ?? 0;
  return {
    since,
    until: now,
    source: "retained_journal" as const,
    grant_denials: Object.fromEntries(
      rows
        .filter((row) => row.kind === "queue.grant_denied")
        .map((row) => [row.detail, row.total]),
    ),
    expired_reservations: count("attempt.expired"),
    uncertainty_events: count("attempt.uncertain"),
    reconciliations: count("attempt.rebound"),
    retries: count("attempt.retried"),
    forced_abandonments: rows
      .filter(
        (row) => row.kind === "attempt.finished" && row.detail === "abandoned",
      )
      .reduce((sum, row) => sum + row.total, 0),
    expired_execution_leases: expired,
  };
}
export function inspect(
  db: ProjectDatabase,
  raw: QueueListQuery = {},
  allowsTask: QueueTaskAccess = allTasks,
  now = Date.now(),
): QueueInspection {
  const query = QueueListQuerySchema.parse(raw);
  return db.transaction((tx) => {
    const snapshot = readReadinessSnapshot(tx, now);
    const latest = new Map<string, WorkAttempt>();
    for (const attempt of tx
      .select()
      .from(schema.workAttempts)
      .orderBy(
        desc(schema.workAttempts.fence),
        desc(schema.workAttempts.created_at),
        desc(schema.workAttempts.id),
      )
      .all())
      if (!latest.has(attempt.entry_id)) latest.set(attempt.entry_id, attempt);
    const counts = {
      backlog: 0,
      active: 0,
      suspended: 0,
      uncertain: 0,
      terminal: 0,
      ...occupancy(tx),
      oldest_waiting_age_ms: null as number | null,
    };
    const entries = tx
      .select()
      .from(schema.queueEntries)
      .orderBy(
        desc(schema.queueEntries.priority),
        asc(schema.queueEntries.enqueue_order),
        asc(schema.queueEntries.id),
      )
      .all()
      .filter((entry) => allowsTask(entry.task_id));
    for (const entry of entries) {
      counts[group(entry, latest.get(entry.id))]++;
      if (entry.state === "queued")
        counts.oldest_waiting_age_ms = Math.max(
          counts.oldest_waiting_age_ms ?? 0,
          now - entry.created_at,
        );
    }
    const filtered = entries.filter(
      (entry) =>
        (!query.task_id || entry.task_id === query.task_id) &&
        (!query.state || group(entry, latest.get(entry.id)) === query.state) &&
        (!query.type ||
          snapshot.entities.get(entry.task_id)?.type === query.type) &&
        (!query.target_principal ||
          entry.target_principal === query.target_principal) &&
        (!query.capability ||
          entry.required_capabilities.includes(query.capability)) &&
        (query.priority === undefined || entry.priority === query.priority) &&
        (!query.lease ||
          (group(entry, latest.get(entry.id)) === "active" &&
            leaseLapsed(latest.get(entry.id), now))),
    );
    return {
      policy: policy(tx),
      diagnostics: diagnostics(tx, now),
      counts,
      total: filtered.length,
      limit: query.limit,
      offset: query.offset,
      effective_capabilities: query.capabilities ?? [],
      entries: filtered
        .slice(query.offset, query.offset + query.limit)
        .map((entry) => ({
          entry,
          task: snapshot.entities.get(entry.task_id) ?? null,
          attempt: latest.get(entry.id) ?? null,
          block_reasons:
            entry.state === "queued"
              ? entryReasons(
                  tx,
                  entry,
                  snapshot,
                  now,
                  undefined,
                  query.capabilities,
                ).map((reason) => {
                  // A blocked visible task must not disclose a restricted predecessor.
                  const references = [reason.resource, ...(reason.path ?? [])];
                  if (
                    reason.code !== "gate-pending" &&
                    references.some(
                      (id) => id !== entry.task_id && !allowsTask(id),
                    )
                  )
                    return { code: reason.code, resource: entry.task_id };
                  return reason;
                })
              : [],
        })),
    };
  });
}
