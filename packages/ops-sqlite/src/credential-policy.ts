import {
  type CredentialPolicy,
  CredentialPolicySchema,
  type NamespaceRestrictions,
  type RecordAccessSide,
  canEchoStoredRecord,
  hasNamespaceRestrictions,
  isReadMethod,
  permitsRecordSide,
  permitsTask,
  recordResourceTarget,
  recordRulesForSide,
} from "@tila/schemas";
import { type SQL, and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  type BaseSQLiteDatabase,
  alias,
} from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

type DB = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
export class CredentialPolicyDenied extends Error {
  constructor() {
    super("Credential does not permit this operation or resource");
  }
}
export function readCredentialPolicy(
  header: string | undefined,
): CredentialPolicy | undefined {
  return header === undefined
    ? undefined
    : CredentialPolicySchema.parse(JSON.parse(header));
}
/**
 * The SQL form of the record rules for one side. Every caller states its side
 * because a split policy admits different records for reading and writing.
 */
export function recordRestrictionCondition(
  restrictions: NamespaceRestrictions | undefined,
  side: RecordAccessSide,
): SQL | undefined {
  const records = recordRulesForSide(restrictions, side);
  if (records === undefined) return undefined;
  const rules = records.map((rule) =>
    and(
      eq(schema.records.type, rule.type),
      rule.key_prefixes === undefined
        ? undefined
        : or(
            sql`0`,
            ...rule.key_prefixes.map((prefix) =>
              or(
                eq(schema.records.key, prefix),
                sql`substr(${schema.records.key}, 1, ${prefix.length + 1}) = ${`${prefix}/`}`,
              ),
            ),
          ),
    ),
  );
  return or(sql`0`, ...rules);
}
export function taskRestrictionCondition(
  db: DB,
  restrictions?: NamespaceRestrictions,
): SQL | undefined {
  if (restrictions?.task_types === undefined) return undefined;
  const parent = alias(schema.entities, "authorized_parent");
  const parentId = sql<string>`json_extract(${schema.entities.data}, '$.parent_id')`;
  return and(
    inArray(schema.entities.type, restrictions.task_types),
    or(
      isNull(parentId),
      inArray(
        parentId,
        db
          .select({ id: parent.id })
          .from(parent)
          .where(inArray(parent.type, restrictions.task_types)),
      ),
    ),
  );
}

export function assertTaskAccess(
  db: DB,
  policy: CredentialPolicy,
  id: unknown,
) {
  if (typeof id !== "string") throw new CredentialPolicyDenied();
  const entity = db
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, id))
    .get();
  if (!entity || !permitsTask(policy.restrictions, entity.type))
    throw new CredentialPolicyDenied();
  return entity;
}
/**
 * The SQL form of `assertTaskAccess` for a column holding task ids: the task's
 * own type must be permitted. Task rows are never deleted and task id columns
 * reference them, so existence needs no check of its own.
 */
export function taskIdAccessCondition(
  db: DB,
  column: AnySQLiteColumn,
  policy?: CredentialPolicy,
): SQL | undefined {
  const types = policy?.restrictions?.task_types;
  if (types === undefined) return undefined;
  return inArray(
    column,
    db
      .select({ id: schema.entities.id })
      .from(schema.entities)
      .where(inArray(schema.entities.type, types)),
  );
}
/**
 * `side` is the side of the namespace the request exercises: reading a claim's
 * state or listing claims is a read, acquiring, renewing or releasing is a
 * write. Task resources have no sides and ignore it.
 */
export function assertResourceAccess(
  db: DB,
  policy: CredentialPolicy,
  resource: unknown,
  side: RecordAccessSide,
) {
  if (typeof resource !== "string") throw new CredentialPolicyDenied();
  if (resource.startsWith("record:")) {
    const target = recordResourceTarget(resource);
    if (
      target === undefined ||
      !permitsRecordSide(policy.restrictions, side, target.type, target.key)
    )
      throw new CredentialPolicyDenied();
    return;
  }
  const colon = resource.indexOf(":");
  const entity = assertTaskAccess(
    db,
    policy,
    colon < 0 ? resource : resource.slice(colon + 1),
  );
  if (colon >= 0 && entity.type !== resource.slice(0, colon))
    throw new CredentialPolicyDenied();
}

/** Record writes whose response is the stored row, not just the caller's input. */
const ECHOING_OPERATIONS: ReadonlySet<string> = new Set([
  "patch",
  "archive",
  "unarchive",
]);

export interface RecordRequestTarget {
  type: string;
  /** A string once the request addresses a record; anything else is denied. */
  key: unknown;
  /** The side of the namespace the request exercises. */
  side: RecordAccessSide;
  /** The response carries the stored row, so the read side is needed too. */
  echoesStored: boolean;
}

/**
 * The record a single-record `/record/...` request addresses, or `undefined`
 * for the routes that filter rows themselves (list and types-in-use). Only
 * GET and HEAD read; every other route is a write, so a route added later is checked
 * against the write side instead of slipping through as a read.
 */
export function recordRequestTarget(
  method: string,
  path: string,
  body: Record<string, unknown>,
): RecordRequestTarget | undefined {
  if (!path.startsWith("/record/") || path === "/record/types-in-use")
    return undefined;
  const segments = path.split("/").slice(2).map(decodeURIComponent);
  const type = segments.shift() ?? "";
  if (segments.length === 1 && segments[0] === "list") return undefined;
  if (isReadMethod(method)) {
    // Value reads and `/history` are the only record GETs.
    if (segments.at(-1) === "history") segments.pop();
    return {
      type,
      key: segments.join("/"),
      side: "read",
      echoesStored: false,
    };
  }
  if (segments.length === 1 && segments[0] === "create")
    return { type, key: body.key, side: "write", echoesStored: false };
  const operation = segments.pop();
  return {
    type,
    key: segments.join("/"),
    side: "write",
    echoesStored: operation !== undefined && ECHOING_OPERATIONS.has(operation),
  };
}

/**
 * True when this record write comes from a split policy that may not read the
 * key: its response and its errors must then carry nothing the caller did not
 * send or already hold.
 */
export function withholdsStoredRecordDetail(
  policy: CredentialPolicy,
  method: string,
  path: string,
  body: Record<string, unknown>,
): boolean {
  const target = recordRequestTarget(method, path, body);
  return (
    target !== undefined &&
    target.side === "write" &&
    typeof target.key === "string" &&
    !canEchoStoredRecord(policy, target.type, target.key)
  );
}

/** Runs before DO side effects and before any DO idempotency replay. */
export function assertCredentialRequest(
  db: DB,
  policy: CredentialPolicy,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
) {
  const restricted = hasNamespaceRestrictions(policy);
  if (path === "/template/instantiate") {
    if (!policy.capabilities.includes("tasks:write"))
      throw new CredentialPolicyDenied();
    return; // Template expansion checks every generated type inside its transaction.
  }
  if (
    body.source_artifact_key &&
    !policy.capabilities.includes("artifacts:read")
  )
    throw new CredentialPolicyDenied();
  if (
    (path === "/entity/artifact-ref" || path === "/entity/artifact-refs") &&
    !policy.capabilities.includes("artifacts:read")
  )
    throw new CredentialPolicyDenied();
  // Queue transport checks capabilities and current task access before any replay.
  if (
    path.startsWith("/queue/") ||
    path.startsWith("/attempts/") ||
    path.startsWith("/questions/")
  )
    return;
  if (!restricted) return;
  if (path === "/schema/current" || path === "/admin/transfer/status") return; // Internal validation/status only, never returned by restricted public routes.
  if (path.startsWith("/record/")) {
    // Listing, counting and type enumeration filter rows by the read side.
    const target = recordRequestTarget(method, path, body);
    if (target === undefined) return;
    if (
      typeof target.key !== "string" ||
      !permitsRecordSide(
        policy.restrictions,
        target.side,
        target.type,
        target.key,
      )
    )
      throw new CredentialPolicyDenied();
    // The response of these operations is the full stored record, which the
    // caller did not send, so they need the read side as well.
    if (
      target.echoesStored &&
      !canEchoStoredRecord(policy, target.type, target.key)
    )
      throw new CredentialPolicyDenied();
    if (body.source_artifact_key) throw new CredentialPolicyDenied();
    return;
  }
  if (path === "/entity/type-counts") return; // Counts apply the restriction themselves.
  if (path === "/search") return; // Search applies restrictions and per-kind capabilities itself.
  if (path === "/entity/list") {
    if (query.get("compact") === "true") throw new CredentialPolicyDenied();
    if (query.has("parent")) assertTaskAccess(db, policy, query.get("parent"));
    return;
  }
  if (path === "/entity/create") {
    if (
      typeof body.type !== "string" ||
      !permitsTask(policy.restrictions, body.type)
    )
      throw new CredentialPolicyDenied();
  } else if (/^\/entity\/(get|update|archive)\//.test(path)) {
    const entity = assertTaskAccess(
      db,
      policy,
      decodeURIComponent(path.split("/").slice(3).join("/")),
    );
    if (query.get("compact") === "true") throw new CredentialPolicyDenied();
    const data = JSON.parse(entity.data) as Record<string, unknown>;
    if (data.parent_id) assertTaskAccess(db, policy, data.parent_id);
  } else if (path.startsWith("/entity/relationship/")) {
    if (path.endsWith("/list")) {
      if (query.has("from_id"))
        assertTaskAccess(db, policy, query.get("from_id"));
      if (query.has("to_id")) assertTaskAccess(db, policy, query.get("to_id"));
      return;
    }
    assertTaskAccess(db, policy, body.from_id);
    assertTaskAccess(db, policy, body.to_id);
    return;
  } else if (path.startsWith("/coord/")) {
    if (path === "/coord/claims") return; // Filter the resource list before return.
    // Claim state is a read of the resource; acquire, renew and release are
    // writes to it.
    assertResourceAccess(
      db,
      policy,
      isReadMethod(method) ? query.get("resource") : body.resource,
      isReadMethod(method) ? "read" : "write",
    );
    return;
  } else throw new CredentialPolicyDenied();
  const data = body.data as Record<string, unknown> | undefined;
  if (data?.parent_id) assertTaskAccess(db, policy, data.parent_id);
}

export function filterRelationships<
  T extends { from_id: string; to_id: string },
>(db: DB, policy: CredentialPolicy | undefined, rows: T[]): T[] {
  if (!policy || !hasNamespaceRestrictions(policy)) return rows;
  return rows.filter((row) => {
    try {
      assertTaskAccess(db, policy, row.from_id);
      assertTaskAccess(db, policy, row.to_id);
      return true;
    } catch (error) {
      if (error instanceof CredentialPolicyDenied) return false;
      throw error;
    }
  });
}
