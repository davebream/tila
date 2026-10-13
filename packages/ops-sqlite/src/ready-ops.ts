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

/** The entity is in a terminal state: its lifecycle's, or legacy `closed`. */
export function isTerminal(
  snapshot: ReadinessSnapshot,
  entity: Entity,
): boolean {
  const lifecycle = snapshot.definition?.work_units[entity.type]?.lifecycle;
  const state = entity.data[lifecycle?.field ?? "status"];
  return lifecycle
    ? typeof state === "string" && lifecycle.terminal.includes(state)
    : state === "closed";
}

/**
 * Whether `id`, as a predecessor, holds back a dependent. `strict` is the
 * dependent's mode: work with a declared lifecycle also rejects missing and
 * lifecycle-unconfigured predecessors. Mirrors the per-predecessor checks in
 * `evaluateReadiness`.
 */
function holdsBack(
  snapshot: ReadinessSnapshot,
  id: string,
  strict: boolean,
): boolean {
  const predecessor = snapshot.entities.get(id);
  if (!predecessor) return strict;
  const mapping = snapshot.definition?.work_units[predecessor.type]?.lifecycle;
  if (mapping) {
    const value = predecessor.data[mapping.field];
    return (
      typeof value !== "string" || !mapping.dependency_satisfied.includes(value)
    );
  }
  if (strict) return true;
  return (
    !predecessor.archived &&
    predecessor.data.status !== undefined &&
    predecessor.data.status !== null &&
    predecessor.data.status !== "closed"
  );
}

interface Component {
  /** Members that hold back a strict or a legacy dependent. */
  strictProblems: number;
  legacyProblems: number;
  /** Some ancestor outside this component holds back a dependent. */
  upstreamStrict: boolean;
  upstreamLegacy: boolean;
  /** This component or one of its ancestors contains a cycle. */
  reachesCycle: boolean;
}

/**
 * Open work held back by its prerequisites: not archived, not terminal, and
 * `evaluateReadiness` would report an unresolved, missing, cyclic or
 * lifecycle-unconfigured predecessor. Pending gates and the task's own state
 * do not count.
 *
 * Instead of one ancestor walk per task, this condenses the predecessor graph
 * into strongly connected components once (iterative Tarjan, so long chains
 * cannot overflow the stack) and propagates "an ancestor holds back" and
 * "an ancestor is cyclic" in a single pass: O(tasks + edges).
 */
export function blockedTaskIds(snapshot: ReadinessSnapshot): Set<string> {
  const predecessorsOf = (id: string) => snapshot.predecessors.get(id) ?? [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  const components: Component[] = [];
  let counter = 0;

  const close = (root: string) => {
    const id = components.length;
    const members: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      componentOf.set(member, id);
      members.push(member);
    } while (member !== root);
    const upstream = new Set<number>();
    let cyclic = members.length > 1;
    for (const m of members)
      for (const p of predecessorsOf(m)) {
        const c = componentOf.get(p) as number;
        if (c === id) cyclic = true;
        else upstream.add(c);
      }
    const above = [...upstream].map((c) => components[c]);
    const reaches = (c: Component, mode: "strict" | "legacy") =>
      (mode === "strict" ? c.strictProblems : c.legacyProblems) > 0 ||
      (mode === "strict" ? c.upstreamStrict : c.upstreamLegacy);
    components.push({
      strictProblems: members.filter((m) => holdsBack(snapshot, m, true))
        .length,
      legacyProblems: members.filter((m) => holdsBack(snapshot, m, false))
        .length,
      upstreamStrict: above.some((c) => reaches(c, "strict")),
      upstreamLegacy: above.some((c) => reaches(c, "legacy")),
      reachesCycle: cyclic || above.some((c) => c.reachesCycle),
    });
  };

  const roots = new Set<string>(snapshot.entities.keys());
  for (const [to, from] of snapshot.predecessors) {
    roots.add(to);
    for (const id of from) roots.add(id);
  }
  for (const root of roots) {
    if (index.has(root)) continue;
    const frames: Array<{ id: string; next: number }> = [];
    const open = (id: string) => {
      index.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      frames.push({ id, next: 0 });
    };
    open(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const predecessors = predecessorsOf(frame.id);
      if (frame.next < predecessors.length) {
        const p = predecessors[frame.next++];
        if (!index.has(p)) open(p);
        else if (onStack.has(p))
          low.set(
            frame.id,
            Math.min(low.get(frame.id) as number, index.get(p) as number),
          );
        continue;
      }
      frames.pop();
      if (low.get(frame.id) === index.get(frame.id)) close(frame.id);
      const parent = frames[frames.length - 1];
      if (parent)
        low.set(
          parent.id,
          Math.min(low.get(parent.id) as number, low.get(frame.id) as number),
        );
    }
  }

  const blocked = new Set<string>();
  for (const entity of snapshot.entities.values()) {
    if (entity.archived || isTerminal(snapshot, entity)) continue;
    const component = components[componentOf.get(entity.id) as number];
    const strict =
      snapshot.definition?.work_units[entity.type]?.lifecycle !== undefined;
    // Other members of its own cycle are also its predecessors.
    const others = strict
      ? component.strictProblems -
        (holdsBack(snapshot, entity.id, true) ? 1 : 0)
      : component.legacyProblems -
        (holdsBack(snapshot, entity.id, false) ? 1 : 0);
    const held = strict
      ? component.reachesCycle || component.upstreamStrict || others > 0
      : component.upstreamLegacy || others > 0;
    if (held) blocked.add(entity.id);
  }
  return blocked;
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
