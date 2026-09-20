import type {
  Signal,
  SignalGroup,
  SignalIdentity,
  SignalTarget,
} from "@tila/schemas";
import { SignalTargetSchema } from "@tila/schemas";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

type SignalDb = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

export interface SendSignalParams {
  target: SignalTarget;
  kind: string;
  resource?: string;
  payload?: unknown;
  ttl_ms?: number;
  sender: SignalIdentity;
}

export interface SendSignalResult {
  id: string;
  recipient_count: number;
}

export interface AckSignalResult {
  found: boolean;
  authorized: boolean;
  expired: boolean;
}

export interface SignalHistoryResult {
  signals: Signal[];
  next_cursor: string | null;
}

export class SignalGroupNotFoundError extends Error {
  readonly code = "signal-group-not-found";
}

export class NoActiveRecipientsError extends Error {
  readonly code = "no-active-recipients";
}

const DEFAULT_TTL_MS = 300_000;
const ACTIVE_PRESENCE_TTL_MS = 60_000;

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function identity(
  principalId: string,
  participantId: string,
  displayName: string | null,
  environment: string,
): SignalIdentity {
  return {
    principal_id: principalId,
    participant_id: participantId,
    display_name: displayName,
    environment: parseJson(environment),
  };
}

function resolveRecipients(
  db: SignalDb,
  target: SignalTarget,
  sender: SignalIdentity,
  now: number,
): SignalIdentity[] {
  if (target.type === "participant") {
    return [
      {
        principal_id: target.principal_id,
        participant_id: target.participant_id,
        display_name: null,
        environment: {},
      },
    ];
  }

  let memberPrincipals: Set<string> | null = null;
  if (target.type === "principal") {
    memberPrincipals = new Set([target.principal_id]);
  } else if (target.type === "group") {
    const group = db
      .select({ id: schema.signalGroups.id })
      .from(schema.signalGroups)
      .where(eq(schema.signalGroups.id, target.group_id))
      .get();
    if (!group) throw new SignalGroupNotFoundError(target.group_id);
    memberPrincipals = new Set(
      db
        .select({ principal_id: schema.signalGroupMembers.principal_id })
        .from(schema.signalGroupMembers)
        .where(eq(schema.signalGroupMembers.group_id, target.group_id))
        .all()
        .map((row) => row.principal_id),
    );
  }

  const recipients = db
    .select()
    .from(schema.presence)
    .where(gt(schema.presence.last_seen, now - ACTIVE_PRESENCE_TTL_MS))
    .all()
    .filter(
      (row) =>
        (memberPrincipals === null || memberPrincipals.has(row.principal_id)) &&
        !(
          row.principal_id === sender.principal_id &&
          row.participant_id === sender.participant_id
        ),
    )
    .map((row) =>
      identity(row.principal_id, row.participant_id, null, row.environment),
    );

  recipients.sort((a, b) =>
    `${a.principal_id}\0${a.participant_id}`.localeCompare(
      `${b.principal_id}\0${b.participant_id}`,
    ),
  );
  return recipients;
}

export function send(
  db: SignalDb,
  params: SendSignalParams,
  now: number = Date.now(),
): SendSignalResult {
  const recipients = resolveRecipients(db, params.target, params.sender, now);
  if (recipients.length === 0) throw new NoActiveRecipientsError();

  const id = `sig_${crypto.randomUUID()}`;
  const ttl = params.ttl_ms ?? DEFAULT_TTL_MS;

  db.transaction((tx) => {
    tx.insert(schema.signals)
      .values({
        id,
        target: JSON.stringify(params.target),
        kind: params.kind,
        resource: params.resource ?? null,
        payload: JSON.stringify(params.payload ?? {}),
        sender_principal_id: params.sender.principal_id,
        sender_participant_id: params.sender.participant_id,
        sender_display_name: params.sender.display_name,
        sender_environment: JSON.stringify(params.sender.environment),
        created_at: now,
        expires_at: now + ttl,
      })
      .run();

    tx.insert(schema.signalDeliveries)
      .values(
        recipients.map((recipient) => ({
          signal_id: id,
          recipient_principal_id: recipient.principal_id,
          recipient_participant_id: recipient.participant_id,
          recipient_display_name: recipient.display_name,
          recipient_environment: JSON.stringify(recipient.environment),
        })),
      )
      .run();
  });

  return { id, recipient_count: recipients.length };
}

function deliveriesFor(db: SignalDb, signalId: string) {
  return db
    .select()
    .from(schema.signalDeliveries)
    .where(eq(schema.signalDeliveries.signal_id, signalId))
    .all()
    .map((row) => ({
      recipient: identity(
        row.recipient_principal_id,
        row.recipient_participant_id,
        row.recipient_display_name,
        row.recipient_environment,
      ),
      acknowledged_at: row.acknowledged_at,
      acknowledged_by:
        row.acknowledged_at !== null &&
        row.acknowledged_by_principal_id !== null &&
        row.acknowledged_by_participant_id !== null
          ? identity(
              row.acknowledged_by_principal_id,
              row.acknowledged_by_participant_id,
              row.acknowledged_by_display_name,
              row.acknowledged_by_environment ?? "{}",
            )
          : null,
    }));
}

function toSignal(
  db: SignalDb,
  row: typeof schema.signals.$inferSelect,
): Signal {
  return {
    id: row.id,
    target: SignalTargetSchema.parse(parseJson(row.target)),
    kind: row.kind as Signal["kind"],
    resource: row.resource,
    payload: parseJson(row.payload),
    sender: identity(
      row.sender_principal_id,
      row.sender_participant_id,
      row.sender_display_name,
      row.sender_environment,
    ),
    created_at: row.created_at,
    expires_at: row.expires_at,
    deliveries: deliveriesFor(db, row.id),
  };
}

export function inbox(
  db: SignalDb,
  recipient: Pick<SignalIdentity, "principal_id" | "participant_id">,
  now: number = Date.now(),
): Signal[] {
  const rows = db
    .select({ signal: schema.signals })
    .from(schema.signals)
    .innerJoin(
      schema.signalDeliveries,
      eq(schema.signalDeliveries.signal_id, schema.signals.id),
    )
    .where(
      and(
        eq(
          schema.signalDeliveries.recipient_principal_id,
          recipient.principal_id,
        ),
        eq(
          schema.signalDeliveries.recipient_participant_id,
          recipient.participant_id,
        ),
        isNull(schema.signalDeliveries.acknowledged_at),
        gt(schema.signals.expires_at, now),
      ),
    )
    .orderBy(desc(schema.signals.created_at), desc(schema.signals.id))
    .all();

  return rows.map(({ signal }) => {
    const result = toSignal(db, signal);
    result.deliveries = result.deliveries.filter(
      (delivery) =>
        delivery.recipient.principal_id === recipient.principal_id &&
        delivery.recipient.participant_id === recipient.participant_id,
    );
    return result;
  });
}

function decodeCursor(
  cursor: string,
): { createdAt: number; id: string } | null {
  const separator = cursor.indexOf(":");
  if (separator < 1) return null;
  const createdAt = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
}

export function history(
  db: SignalDb,
  options: { limit?: number; cursor?: string } = {},
  now: number = Date.now(),
): SignalHistoryResult {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const where = cursor
    ? and(
        gt(schema.signals.expires_at, now),
        or(
          lt(schema.signals.created_at, cursor.createdAt),
          and(
            eq(schema.signals.created_at, cursor.createdAt),
            lt(schema.signals.id, cursor.id),
          ),
        ),
      )
    : gt(schema.signals.expires_at, now);
  const rows = db
    .select()
    .from(schema.signals)
    .where(where)
    .orderBy(desc(schema.signals.created_at), desc(schema.signals.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  return {
    signals: rows.map((row) => toSignal(db, row)),
    next_cursor: hasMore && last ? `${last.created_at}:${last.id}` : null,
  };
}

export function ack(
  db: SignalDb,
  signalId: string,
  acknowledger: SignalIdentity,
  now: number = Date.now(),
): AckSignalResult {
  return db.transaction((tx) => {
    const existing = tx
      .select({ expires_at: schema.signals.expires_at })
      .from(schema.signals)
      .where(eq(schema.signals.id, signalId))
      .get();
    if (!existing) return { found: false, authorized: false, expired: false };
    if (existing.expires_at <= now)
      return { found: true, authorized: false, expired: true };

    const delivery = tx
      .select()
      .from(schema.signalDeliveries)
      .where(
        and(
          eq(schema.signalDeliveries.signal_id, signalId),
          eq(
            schema.signalDeliveries.recipient_principal_id,
            acknowledger.principal_id,
          ),
          eq(
            schema.signalDeliveries.recipient_participant_id,
            acknowledger.participant_id,
          ),
        ),
      )
      .get();
    if (!delivery) return { found: true, authorized: false, expired: false };
    if (delivery.acknowledged_at !== null)
      return { found: true, authorized: true, expired: false };

    tx.update(schema.signalDeliveries)
      .set({
        acknowledged_at: now,
        acknowledged_by_principal_id: acknowledger.principal_id,
        acknowledged_by_participant_id: acknowledger.participant_id,
        acknowledged_by_display_name: acknowledger.display_name,
        acknowledged_by_environment: JSON.stringify(acknowledger.environment),
      })
      .where(
        and(
          eq(schema.signalDeliveries.signal_id, signalId),
          eq(
            schema.signalDeliveries.recipient_principal_id,
            acknowledger.principal_id,
          ),
          eq(
            schema.signalDeliveries.recipient_participant_id,
            acknowledger.participant_id,
          ),
          isNull(schema.signalDeliveries.acknowledged_at),
        ),
      )
      .run();
    return { found: true, authorized: true, expired: false };
  });
}

function toGroup(db: SignalDb, row: typeof schema.signalGroups.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    principal_ids: db
      .select({ principal_id: schema.signalGroupMembers.principal_id })
      .from(schema.signalGroupMembers)
      .where(eq(schema.signalGroupMembers.group_id, row.id))
      .all()
      .map((member) => member.principal_id)
      .sort(),
    created_at: row.created_at,
    updated_at: row.updated_at,
  } satisfies SignalGroup;
}

export function listGroups(db: SignalDb): SignalGroup[] {
  return db
    .select()
    .from(schema.signalGroups)
    .orderBy(schema.signalGroups.name, schema.signalGroups.id)
    .all()
    .map((row) => toGroup(db, row));
}

export function getGroup(db: SignalDb, groupId: string): SignalGroup | null {
  const row = db
    .select()
    .from(schema.signalGroups)
    .where(eq(schema.signalGroups.id, groupId))
    .get();
  return row ? toGroup(db, row) : null;
}

export function setGroup(
  db: SignalDb,
  groupId: string,
  name: string,
  principalIds: string[],
  actor: Pick<SignalIdentity, "principal_id" | "participant_id">,
  now: number = Date.now(),
): SignalGroup {
  const members = [...new Set(principalIds)].sort();
  db.transaction((tx) => {
    tx.insert(schema.signalGroups)
      .values({
        id: groupId,
        name,
        created_at: now,
        updated_at: now,
        created_by_principal_id: actor.principal_id,
        created_by_participant_id: actor.participant_id,
        updated_by_principal_id: actor.principal_id,
        updated_by_participant_id: actor.participant_id,
      })
      .onConflictDoUpdate({
        target: schema.signalGroups.id,
        set: {
          name,
          updated_at: now,
          updated_by_principal_id: actor.principal_id,
          updated_by_participant_id: actor.participant_id,
        },
      })
      .run();
    tx.delete(schema.signalGroupMembers)
      .where(eq(schema.signalGroupMembers.group_id, groupId))
      .run();
    if (members.length > 0) {
      tx.insert(schema.signalGroupMembers)
        .values(
          members.map((principalId) => ({
            group_id: groupId,
            principal_id: principalId,
            added_at: now,
            added_by_principal_id: actor.principal_id,
            added_by_participant_id: actor.participant_id,
          })),
        )
        .run();
    }
  });
  return getGroup(db, groupId) as SignalGroup;
}

export function deleteGroup(db: SignalDb, groupId: string): boolean {
  return db.transaction((tx) => {
    const exists = tx
      .select({ id: schema.signalGroups.id })
      .from(schema.signalGroups)
      .where(eq(schema.signalGroups.id, groupId))
      .get();
    if (!exists) return false;
    tx.delete(schema.signalGroupMembers)
      .where(eq(schema.signalGroupMembers.group_id, groupId))
      .run();
    tx.delete(schema.signalGroups)
      .where(eq(schema.signalGroups.id, groupId))
      .run();
    return true;
  });
}
