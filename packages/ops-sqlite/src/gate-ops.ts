import type { JournalEventKind } from "@tila/schemas";
import { eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { assertResourceFence } from "./fence-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";

// --- Error classes ---

export class GateNotFoundError extends Error {
  constructor(gateId: string) {
    super(`Gate ${gateId} not found`);
    this.name = "GateNotFoundError";
  }
}

export class GateAlreadySettledError extends Error {
  constructor(gateId: string, currentStatus: string) {
    super(`Gate ${gateId} is already ${currentStatus}`);
    this.name = "GateAlreadySettledError";
  }
}

export class GateFenceError extends Error {
  public readonly code = "gate-fence-conflict";
  constructor(resource: string) {
    super(
      `No fence row for resource ${resource} — claim must be acquired before creating a gate`,
    );
    this.name = "GateFenceError";
  }
}

export class GateBlockedError extends Error {
  public readonly code = "gate-blocked";
  public readonly gateIds: string[];
  public readonly resource: string;
  constructor(resource: string, gateIds: string[]) {
    super(
      `Entity ${resource} has ${gateIds.length} pending gate(s): ${gateIds.join(", ")}`,
    );
    this.name = "GateBlockedError";
    this.gateIds = gateIds;
    this.resource = resource;
  }
}

/**
 * Transaction-scoped gate check for terminal transitions.
 *
 * 1. Resolves expired timer gates (write-on-read, same predicate as listGates)
 * 2. Checks for remaining pending non-expired gates on the resource
 * 3. Throws GateBlockedError if any pending gates remain
 *
 * IMPORTANT: This function takes a Drizzle transaction (tx), not a top-level db.
 * It must be called inside an existing transaction (e.g., entity-ops.update()).
 * Calling listGates(db) from within a transaction would create a nested
 * db.transaction() call which is problematic in DO SQLite.
 *
 * Note: Write-path timer resolution does NOT produce gate.timed_out journal
 * entries. This is an accepted v0.1 gap -- the gate's status/resolved_at fields
 * are correct; only the journal record is missing for write-path-only resolutions.
 */
export function checkPendingGates(
  tx: Parameters<
    Parameters<
      BaseSQLiteDatabase<"sync", unknown, typeof schema>["transaction"]
    >[0]
  >[0],
  resource: string,
  now: number = Date.now(),
): void {
  // Step 1: Resolve expired timer gates (write-on-read)
  const expiredTimerGates = tx
    .select({ id: schema.gates.id })
    .from(schema.gates)
    .where(
      sql`${schema.gates.resource} = ${resource}
        AND ${schema.gates.resolved_at} IS NULL
        AND ${schema.gates.timeout_at} IS NOT NULL
        AND ${schema.gates.timeout_at} <= ${now}`,
    )
    .all();

  for (const gate of expiredTimerGates) {
    tx.update(schema.gates)
      .set({ status: "timed_out", resolved_at: now })
      .where(eq(schema.gates.id, gate.id))
      .run();
  }

  // Step 2: Query remaining pending non-expired gates
  // Mirrors the predicate in ready-ops.ts:
  //   g.resolved_at IS NULL AND (g.timeout_at IS NULL OR g.timeout_at > now)
  const pendingGates = tx
    .select({ id: schema.gates.id })
    .from(schema.gates)
    .where(
      sql`${schema.gates.resource} = ${resource}
        AND ${schema.gates.resolved_at} IS NULL
        AND (${schema.gates.timeout_at} IS NULL OR ${schema.gates.timeout_at} > ${now})`,
    )
    .all();

  if (pendingGates.length > 0) {
    throw new GateBlockedError(
      resource,
      pendingGates.map((g) => g.id),
    );
  }
}

// --- Types ---

export interface CreateGateParams {
  id: string;
  resource: string;
  await_type: string;
  fence: number;
  timeout_at?: number;
  data?: Record<string, unknown>;
}

export interface GateRow {
  id: string;
  resource: string;
  await_type: string;
  status: string;
  fence: number;
  timeout_at: number | null;
  resolved_at: number | null;
  resolution: string | null;
  created_at: number;
  created_by: string;
  token_id: string | null;
  data: Record<string, unknown>;
}

// --- Helper ---

function rowToGate(row: typeof schema.gates.$inferSelect): GateRow {
  return {
    id: row.id,
    resource: row.resource,
    await_type: row.await_type,
    status: row.status,
    fence: row.fence,
    timeout_at: row.timeout_at,
    resolved_at: row.resolved_at,
    resolution: row.resolution,
    created_at: row.created_at,
    created_by: row.created_by,
    token_id: row.token_id,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

// --- Operations ---

export function createGate(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  params: CreateGateParams,
  origin: RequestOrigin,
  now: number = Date.now(),
): GateRow {
  return db.transaction((tx) => {
    assertResourceFence(tx, params.resource, params.fence);

    // Insert gate
    tx.insert(schema.gates)
      .values({
        id: params.id,
        resource: params.resource,
        await_type: params.await_type,
        status: "pending",
        fence: params.fence,
        timeout_at: params.timeout_at ?? null,
        resolved_at: null,
        resolution: null,
        created_at: now,
        created_by: origin.actor,
        token_id: origin.tokenId ?? null,
        data: JSON.stringify(params.data ?? {}),
      })
      .run();

    appendJournal(tx, {
      kind: "gate.created" as JournalEventKind,
      resource: params.resource,
      actor: origin.actor,
      fence: params.fence,
      data: {
        gate_id: params.id,
        await_type: params.await_type,
      },
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });

    return {
      id: params.id,
      resource: params.resource,
      await_type: params.await_type,
      status: "pending",
      fence: params.fence,
      timeout_at: params.timeout_at ?? null,
      resolved_at: null,
      resolution: null,
      created_at: now,
      created_by: origin.actor,
      token_id: origin.tokenId ?? null,
      data: params.data ?? {},
    };
  });
}

// Permission-gated by design, not fence-gated — see docs/01-DECISIONS.md § 21.
export function resolveGate(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  gateId: string,
  resolution?: string,
  origin?: RequestOrigin,
  now: number = Date.now(),
): void {
  db.transaction((tx) => {
    const gate = tx
      .select()
      .from(schema.gates)
      .where(eq(schema.gates.id, gateId))
      .get();

    if (!gate) {
      throw new GateNotFoundError(gateId);
    }

    if (gate.status !== "pending") {
      throw new GateAlreadySettledError(gateId, gate.status);
    }

    tx.update(schema.gates)
      .set({
        status: "resolved",
        resolved_at: now,
        resolution: resolution ?? null,
      })
      .where(eq(schema.gates.id, gateId))
      .run();

    appendJournal(tx, {
      kind: "gate.resolved" as JournalEventKind,
      resource: gate.resource,
      actor: origin?.actor ?? "system",
      fence: gate.fence,
      data: {
        gate_id: gateId,
        resolution: resolution ?? null,
      },
      tokenId: origin?.tokenId,
      source: origin?.source,
      sourceVersion: origin?.sourceVersion,
    });
  });
}

// Permission-gated by design, not fence-gated — see docs/01-DECISIONS.md § 21.
export function cancelGate(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  gateId: string,
  origin: RequestOrigin,
  now: number = Date.now(),
): void {
  db.transaction((tx) => {
    const gate = tx
      .select()
      .from(schema.gates)
      .where(eq(schema.gates.id, gateId))
      .get();

    if (!gate) {
      throw new GateNotFoundError(gateId);
    }

    if (gate.status !== "pending") {
      throw new GateAlreadySettledError(gateId, gate.status);
    }

    tx.update(schema.gates)
      .set({
        status: "cancelled",
        resolved_at: now,
      })
      .where(eq(schema.gates.id, gateId))
      .run();

    appendJournal(tx, {
      kind: "gate.cancelled" as JournalEventKind,
      resource: gate.resource,
      actor: origin.actor,
      fence: gate.fence,
      data: { gate_id: gateId },
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
    });
  });
}

export function listGates(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  query?: {
    resource?: string;
    status?: string;
    limit?: number;
  },
  now: number = Date.now(),
): GateRow[] {
  return db.transaction((tx) => {
    // Step 1: Eagerly resolve expired timer gates (write-on-read)
    const expiredTimerGates = tx
      .select()
      .from(schema.gates)
      .where(
        sql`${schema.gates.resolved_at} IS NULL AND ${schema.gates.timeout_at} IS NOT NULL AND ${schema.gates.timeout_at} <= ${now}`,
      )
      .all();

    for (const gate of expiredTimerGates) {
      tx.update(schema.gates)
        .set({
          status: "timed_out",
          resolved_at: now,
        })
        .where(eq(schema.gates.id, gate.id))
        .run();

      appendJournal(tx, {
        kind: "gate.timed_out" as JournalEventKind,
        resource: gate.resource,
        actor: "system",
        fence: gate.fence,
        data: { gate_id: gate.id },
      });
    }

    // Step 2: Query gates with optional filters
    const conditions: ReturnType<typeof sql>[] = [];
    if (query?.resource) {
      conditions.push(sql`${schema.gates.resource} = ${query.resource}`);
    }
    if (query?.status) {
      conditions.push(sql`${schema.gates.status} = ${query.status}`);
    }

    const whereClause =
      conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;

    const limit = query?.limit ?? 100;

    const rows = tx
      .select()
      .from(schema.gates)
      .where(whereClause)
      .limit(limit)
      .all();

    return rows.map(rowToGate);
  });
}
