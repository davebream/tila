import type {
  Entity,
  TilaSchemaToml,
  WorkBlockReason,
  WorkReadiness,
} from "@tila/schemas";
import { and, gt, inArray, isNull, or } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { resolveCurrentSchema } from "./constraint-ops";
import * as schema from "./schema";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;
export interface ReadinessSnapshot {
  definition: TilaSchemaToml | null;
  entities: Map<string, Entity>;
  predecessors: Map<string, string[]>;
  gates: Map<string, string[]>;
}

/** The caller holds the project transaction when using this for admission. */
export function readReadinessSnapshot(
  db: Db,
  now = Date.now(),
  includeSoftBlocked = false,
): ReadinessSnapshot {
  const definition = resolveCurrentSchema(db);
  const entities = new Map(
    db
      .select()
      .from(schema.entities)
      .all()
      .map((row) => [
        row.id,
        {
          ...row,
          data: JSON.parse(row.data) as Record<string, unknown>,
          tags: [],
        } as Entity,
      ]),
  );
  const predecessors = new Map<string, string[]>();
  for (const edge of db
    .select()
    .from(schema.entityRelationships)
    .where(
      inArray(
        schema.entityRelationships.type,
        includeSoftBlocked ? ["blocks"] : ["blocks", "soft-blocks"],
      ),
    )
    .all()) {
    const incoming = predecessors.get(edge.to_id) ?? [];
    incoming.push(edge.from_id);
    predecessors.set(edge.to_id, incoming);
  }
  const gates = new Map<string, string[]>();
  for (const gate of db
    .select()
    .from(schema.gates)
    .where(
      and(
        isNull(schema.gates.resolved_at),
        or(isNull(schema.gates.timeout_at), gt(schema.gates.timeout_at, now)),
      ),
    )
    .all()) {
    const pending = gates.get(gate.resource) ?? [];
    pending.push(gate.id);
    gates.set(gate.resource, pending);
  }
  return { definition, entities, predecessors, gates };
}

/**
 * Readiness is independent of queue ownership/capacity. Configured work uses
 * explicit lifecycle states. Managed admission must pass requireLifecycle=true;
 * it never guesses successful outcomes for an unconfigured dependency.
 */
export function evaluateReadiness(
  snapshot: ReadinessSnapshot,
  id: string,
  requireLifecycle = false,
): WorkReadiness {
  const reasons: WorkBlockReason[] = [];
  const seen = new Set<string>();
  const add = (reason: WorkBlockReason) => {
    const key = JSON.stringify(reason);
    if (!seen.has(key)) {
      reasons.push(reason);
      seen.add(key);
    }
  };
  const entity = snapshot.entities.get(id);
  if (!entity)
    return { ready: false, reasons: [{ code: "missing", resource: id }] };
  const lifecycle = snapshot.definition?.work_units[entity.type]?.lifecycle;
  const strict = requireLifecycle || lifecycle !== undefined;
  if (entity.archived) add({ code: "archived", resource: id });
  if (!lifecycle && requireLifecycle)
    add({ code: "lifecycle-unconfigured", resource: id });
  const state = entity.data[lifecycle?.field ?? "status"];
  if (
    lifecycle
      ? typeof state !== "string" || !lifecycle.dispatchable.includes(state)
      : state === undefined || state === null || state === "closed"
  ) {
    add({
      code: "not-dispatchable",
      resource: id,
      ...(typeof state === "string" ? { state } : {}),
    });
  }
  for (const resource of [id, `${entity.type}:${id}`]) {
    for (const gateId of snapshot.gates.get(resource) ?? [])
      add({ code: "gate-pending", resource: gateId });
  }

  // Iterative DFS avoids a JS stack overflow on long chains, and marks each
  // ancestor once. Retain edges through successful predecessors: an unresolved
  // transitive prerequisite or a cycle must not disappear from eligibility.
  const colors = new Map<string, "visiting" | "visited">();
  const path: string[] = [];
  const stack = [{ id, exit: false }];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    if (current.exit) {
      colors.set(current.id, "visited");
      path.pop();
      continue;
    }
    if (colors.get(current.id) === "visited") continue;
    if (colors.get(current.id) === "visiting") {
      if (strict)
        add({
          code: "dependency-cycle",
          resource: current.id,
          path: [...path.slice(path.indexOf(current.id)), current.id],
        });
      continue;
    }
    colors.set(current.id, "visiting");
    path.push(current.id);
    if (current.id !== id) {
      const predecessor = snapshot.entities.get(current.id);
      const mapping =
        predecessor &&
        snapshot.definition?.work_units[predecessor.type]?.lifecycle;
      if (!predecessor) {
        if (strict) add({ code: "dependency-missing", resource: current.id });
      } else if (mapping) {
        const value = predecessor.data[mapping.field];
        // Archival never substitutes for success. An explicitly successful
        // predecessor remains successful if it is subsequently archived.
        if (
          typeof value !== "string" ||
          !mapping.dependency_satisfied.includes(value)
        )
          add({
            code: "dependency-unsatisfied",
            resource: current.id,
            ...(typeof value === "string" ? { state: value } : {}),
          });
      } else if (strict) {
        add({
          code: "dependency-lifecycle-unconfigured",
          resource: current.id,
        });
      } else if (
        !predecessor.archived &&
        predecessor.data.status !== undefined &&
        predecessor.data.status !== null &&
        predecessor.data.status !== "closed"
      ) {
        // Preserve the documented legacy SQL predicate for unconfigured work.
        add({ code: "dependency-unsatisfied", resource: current.id });
      }
    }
    stack.push({ id: current.id, exit: true });
    for (const predecessor of snapshot.predecessors.get(current.id) ?? [])
      stack.push({ id: predecessor, exit: false });
  }
  return { ready: reasons.length === 0, reasons };
}

export function computeReadyEntities(
  db: Db,
  opts?: {
    type?: string;
    parent?: string;
    limit?: number;
    includeSoftBlocked?: boolean;
  },
  now = Date.now(),
): Entity[] {
  if (opts?.limit !== undefined && !Number.isFinite(opts.limit))
    throw new Error("Invalid limit parameter: must be a finite number");
  return db.transaction((tx) => {
    const snapshot = readReadinessSnapshot(
      tx,
      now,
      opts?.includeSoftBlocked ?? false,
    );
    const ready: Entity[] = [];
    const limit =
      opts?.limit === undefined || opts.limit < 0
        ? Number.POSITIVE_INFINITY
        : Math.floor(opts.limit);
    for (const entity of snapshot.entities.values()) {
      if (ready.length >= limit) break;
      if (opts?.type !== undefined && entity.type !== opts.type) continue;
      if (opts?.parent !== undefined && entity.data.parent_id !== opts.parent)
        continue;
      if (evaluateReadiness(snapshot, entity.id).ready) ready.push(entity);
    }
    return ready;
  });
}
