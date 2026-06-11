import type { TemplateDefinition, TilaSchemaToml } from "@tila/schemas";
import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  checkEntityTypeDeclared,
  resolveCurrentSchema,
} from "./constraint-ops";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";
import { getCurrentSchema } from "./schema-ops";

/**
 * Machine-readable failure codes for template instantiation. Map 1:1 to the
 * HTTP statuses the DO `/template/instantiate` route has always returned, so
 * callers can translate without re-deriving the status:
 *   - invalid-id            -> 422
 *   - no-schema             -> 422
 *   - not-found             -> 404
 *   - constraint-violation  -> 422
 */
export type TemplateInstantiateErrorCode =
  | "invalid-id"
  | "no-schema"
  | "not-found"
  | "constraint-violation";

/**
 * Typed error thrown by {@link instantiateTemplate}. Both callers (the DO
 * route and `EmbeddedProject`) map `.code` to their own error representation
 * (`jsonError` status / `TemplateError`) with a byte-identical message.
 */
export class TemplateInstantiateError extends Error {
  readonly code: TemplateInstantiateErrorCode;

  constructor(code: TemplateInstantiateErrorCode, message: string) {
    super(message);
    this.name = "TemplateInstantiateError";
    this.code = code;
  }
}

export interface InstantiateTemplateParams {
  /** Template name to look up in the current schema's `[templates.*]`. */
  templateName: string;
  /** Root entity ID; each template entity's id_suffix is appended to it. */
  rootId: string;
  /** `{{var}}` substitution values applied to template entity data. */
  vars: Record<string, string>;
  /**
   * Actor + provenance for the entity rows (`created_by`) and the
   * `template.instantiated` journal event. This is the per-caller difference
   * (DO passes its request origin defaulting to "system"; the embedded backend
   * passes a local actor/origin) — made an explicit argument so the divergence
   * is deliberate, not a silent copy-paste drift.
   */
  origin: RequestOrigin;
}

export interface InstantiateTemplateResult {
  created_entities: string[];
  created_relationships: number;
  journal_seq: number;
}

/**
 * Pure guard: validate that a template can be instantiated against `parsedSchema`
 * with `rootId`, returning the resolved template definition. Throws a
 * {@link TemplateInstantiateError} for:
 *   - `not-found`            — template name absent from the schema.
 *   - `constraint-violation` — a template entity references an undeclared
 *                              work-unit type (`checkEntityTypeDeclared`). This
 *                              is a defensive re-check: the schema parser already
 *                              rejects such templates at apply time, but the op
 *                              owns the invariant independently.
 *   - `invalid-id`           — a computed entity ID (root_id + id_suffix) contains '/'.
 *
 * Exported so it is unit-testable in isolation (with a hand-built schema) and so
 * the `root_id` + `no-schema` guards stay where they belong (in the DB-aware
 * {@link instantiateTemplate}).
 */
export function validateTemplateInstantiation(
  parsedSchema: TilaSchemaToml,
  templateName: string,
  rootId: string,
): TemplateDefinition {
  const templateDef = parsedSchema.templates?.[templateName];
  if (!templateDef) {
    throw new TemplateInstantiateError(
      "not-found",
      `Template "${templateName}" not found in schema`,
    );
  }

  // Every template entity's work-unit type must be declared.
  for (const [entityKey, entity] of Object.entries(templateDef.entities)) {
    const typeCheck = checkEntityTypeDeclared(parsedSchema, entity.type);
    if (!typeCheck.ok) {
      throw new TemplateInstantiateError(
        "constraint-violation",
        `Template entity "${entityKey}": ${typeCheck.message}`,
      );
    }
  }

  // Every computed entity ID must not contain '/'.
  for (const [entityKey, entity] of Object.entries(templateDef.entities)) {
    const entityId = rootId + entity.id_suffix;
    if (entityId.includes("/")) {
      throw new TemplateInstantiateError(
        "invalid-id",
        `Computed entity ID "${entityId}" (from entity "${entityKey}") contains '/'`,
      );
    }
  }

  return templateDef;
}

/** Substitute `{{var}}` placeholders in a single value (strings only). */
function applyVar(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value !== "string") return value;
  return value.replace(
    /\{\{(\w+)\}\}/g,
    (_, k: string) => vars[k] ?? `{{${k}}}`,
  );
}

/** Substitute `{{var}}` placeholders across every value of an entity's data. */
function applyVarsToData(
  data: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([k, val]) => [k, applyVar(val, vars)]),
  );
}

/**
 * Instantiate a schema template: create its entities + relationships and append
 * a `template.instantiated` journal event, all inside a single transaction
 * (atomic — a mid-instantiate failure rolls back every insert and the journal
 * row). Driver-agnostic: works on any `BaseSQLiteDatabase<"sync", ...>` (DO
 * SQLite, bun:sqlite, better-sqlite3).
 *
 * This is the single source of truth for template instantiation, shared by the
 * DO `/template/instantiate` route and `EmbeddedProject.instantiateTemplate`
 * (CLAUDE.md: "Add new ops modules to @tila/ops-sqlite, not backend-do
 * directly"). Both callers are thin wrappers that map {@link TemplateInstantiateError}
 * to their own error type.
 *
 * Guards (in order), each throwing a {@link TemplateInstantiateError}:
 *  1. `invalid-id`           — `root_id` contains '/'.
 *  2. `no-schema`            — no schema applied to the project.
 *  3. `not-found`            — template name absent from the schema.
 *  4. `constraint-violation` — a template entity references an undeclared
 *                              work-unit type (`checkEntityTypeDeclared`).
 *  5. `invalid-id`           — a computed entity ID (root_id + id_suffix) contains '/'.
 */
export function instantiateTemplate(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  params: InstantiateTemplateParams,
): InstantiateTemplateResult {
  const { templateName, rootId, vars, origin } = params;

  // Guard 1: root_id must not contain '/'.
  if (rootId.includes("/")) {
    throw new TemplateInstantiateError(
      "invalid-id",
      `root_id "${rootId}" contains '/' which is not allowed in entity IDs`,
    );
  }

  // Guard 2: a schema must be applied.
  const parsedSchema = resolveCurrentSchema(db);
  if (!parsedSchema) {
    throw new TemplateInstantiateError(
      "no-schema",
      "No schema applied to this project",
    );
  }

  // Guards 3-5 (template found, declared types, computed-id valid) — pure,
  // unit-testable in isolation.
  const templateDef = validateTemplateInstantiation(
    parsedSchema,
    templateName,
    rootId,
  );

  const schemaVersion = getCurrentSchema(db)?.version ?? 1;
  const now = Date.now();

  return db.transaction((tx) => {
    const entityIds: string[] = [];
    let relCount = 0;

    for (const [, entity] of Object.entries(templateDef.entities)) {
      const entityId = rootId + entity.id_suffix;
      const data = applyVarsToData(
        entity.data as Record<string, unknown>,
        vars,
      );
      tx.insert(schema.entities)
        .values({
          id: entityId,
          type: entity.type,
          schema_version: schemaVersion,
          data: JSON.stringify(data),
          archived: 0,
          created_at: now,
          updated_at: now,
          created_by: origin.actor,
        })
        .run();
      entityIds.push(entityId);
    }

    for (const rel of templateDef.relationships) {
      const fromEntity = templateDef.entities[rel.from];
      const toEntity = templateDef.entities[rel.to];
      if (!fromEntity || !toEntity) continue;
      const fromId = rootId + fromEntity.id_suffix;
      const toId = rootId + toEntity.id_suffix;
      tx.run(
        sql`INSERT INTO entity_relationships (from_id, to_id, type, schema_version, created_at) VALUES (${fromId}, ${toId}, ${rel.type}, ${schemaVersion}, ${now})`,
      );
      relCount++;
    }

    appendJournal(tx, {
      kind: "template.instantiated",
      resource: rootId,
      actor: origin.actor,
      tokenId: origin.tokenId,
      source: origin.source,
      sourceVersion: origin.sourceVersion,
      data: {
        template_name: templateName,
        created_entity_ids: entityIds,
        vars_used: Object.keys(vars),
      },
    });

    const seqRow = tx
      .select({ seq: schema.journal.seq })
      .from(schema.journal)
      .orderBy(sql`seq DESC`)
      .limit(1)
      .get();
    const journalSeq = seqRow?.seq ?? 0;

    return {
      created_entities: entityIds,
      created_relationships: relCount,
      journal_seq: journalSeq,
    };
  });
}
