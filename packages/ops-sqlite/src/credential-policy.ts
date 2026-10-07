import {
  type CredentialPolicy,
  CredentialPolicySchema,
  type NamespaceRestrictions,
  hasNamespaceRestrictions,
  permitsRecord,
  permitsTask,
} from "@tila/schemas";
import { type SQL, and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { type BaseSQLiteDatabase, alias } from "drizzle-orm/sqlite-core";
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
export function recordRestrictionCondition(
  restrictions?: NamespaceRestrictions,
): SQL | undefined {
  if (restrictions?.records === undefined) return undefined;
  const rules = restrictions.records.map((rule) =>
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
export function assertResourceAccess(
  db: DB,
  policy: CredentialPolicy,
  resource: unknown,
) {
  if (typeof resource !== "string") throw new CredentialPolicyDenied();
  if (resource.startsWith("record:")) {
    const rest = resource.slice(7);
    const slash = rest.indexOf("/");
    if (
      slash < 1 ||
      !permitsRecord(
        policy.restrictions,
        rest.slice(0, slash),
        rest.slice(slash + 1),
      )
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
  if (!restricted) return;
  if (path === "/schema/current" || path === "/admin/transfer/status") return; // Internal validation/status only, never returned by restricted public routes.
  if (path.startsWith("/record/")) {
    if (path === "/record/types-in-use") return;
    const segments = path.split("/").slice(2).map(decodeURIComponent);
    const type = segments.shift() ?? "";
    if (segments.length === 1 && segments[0] === "list") return;
    let key: unknown;
    if (method === "POST" && segments.length === 1 && segments[0] === "create")
      key = body.key;
    else {
      if (method !== "GET" || segments.at(-1) === "history") segments.pop();
      key = segments.join("/");
    }
    if (
      typeof key !== "string" ||
      !permitsRecord(policy.restrictions, type, key)
    )
      throw new CredentialPolicyDenied();
    if (body.source_artifact_key) throw new CredentialPolicyDenied();
    return;
  }
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
    assertResourceAccess(
      db,
      policy,
      method === "GET" ? query.get("resource") : body.resource,
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
