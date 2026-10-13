import {
  type SchemaChange,
  type SchemaFieldChange,
  SchemaParseException,
  type SchemaRecordChange,
  diffSchemas,
  findForbiddenDefinitionContent,
  parseDefinitionDocument,
  parseTilaSchemaToml,
} from "@tila/core";
import {
  type ArtifactPolicyImpact,
  DEFINITION_MAX_BYTES,
  SchemaApplyRequestSchema,
  type SchemaHistory,
  type SchemaPreviewChange,
  type TilaSchemaToml,
  canonicalJson,
  definitionByteLength,
} from "@tila/schemas";
import { type SQL, and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { withDoIdempotency } from "./do-idempotency-ops";
import { refreshPresentedSearchTitles } from "./entity-search-text";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";

export { SchemaParseException };

/**
 * A schema change enriched with database impact counts (see
 * `SchemaPreviewChangeSchema`). Removals carry the rows they affect, added
 * fields with `default_for_legacy` carry the rows that will read the default
 * lazily, and artifact policy edits carry their effect on stored artifacts.
 *
 * Note: field counts use `json_extract` to detect key presence. It returns SQL
 * NULL for both "key absent" and "value is JSON null", so removal counts may
 * slightly undercount rows whose value is explicitly null.
 */
export type PreviewSchemaChange = SchemaPreviewChange;

export type PreviewSchemaResult = {
  revision: number;
  reviewed_definition: string;
  changes: PreviewSchemaChange[];
  autoApplicable: boolean;
};

export type ApplySchemaResult =
  | { ok: true; version: number; revision: number; changes: string[] }
  | { ok: false; reason: "no-change"; revision: number }
  | { ok: false; reason: "destructive"; changes: string[]; hint: string };

export class SchemaPreconditionError extends Error {
  constructor(
    public readonly code:
      | "schema-revision-required"
      | "schema-revision-conflict"
      | "schema-review-required"
      | "schema-review-mismatch",
    public readonly revision: number,
  ) {
    super(
      `${code}: preview the current configuration and retry with its revision and reviewed definition`,
    );
    this.name = "SchemaPreconditionError";
  }
}

/** A definition (or its reviewed copy) over `DEFINITION_MAX_BYTES`. */
export class DefinitionTooLargeError extends Error {
  constructor(
    public readonly field: "definition" | "reviewed_definition",
    public readonly bytes: number,
  ) {
    super(
      `${field} is ${Math.ceil(bytes / 1024)} KiB; definitions are limited to ${DEFINITION_MAX_BYTES / 1024} KiB`,
    );
    this.name = "DefinitionTooLargeError";
  }
}

/**
 * Guard for every new definition write (preview and apply), never for reads
 * of stored text: size first, then content no definition may carry
 * (credentials, export metadata, a client connection file). Failures use the
 * parse-error envelope so clients show them like any other path error.
 */
function assertWritableDefinition(definition: string, reviewed?: string): void {
  const bytes = definitionByteLength(definition);
  if (bytes > DEFINITION_MAX_BYTES)
    throw new DefinitionTooLargeError("definition", bytes);
  if (reviewed !== undefined) {
    const reviewedBytes = definitionByteLength(reviewed);
    if (reviewedBytes > DEFINITION_MAX_BYTES)
      throw new DefinitionTooLargeError("reviewed_definition", reviewedBytes);
  }
  const doc = parseDefinitionDocument(definition);
  if (!doc.ok) throw new SchemaParseException(doc.errors);
  const forbidden = findForbiddenDefinitionContent(doc.doc);
  if (forbidden.length > 0)
    throw new SchemaParseException(
      forbidden.map(({ message, path }) => ({ message, path })),
    );
}

export interface SchemaApplyOptions {
  expected_revision?: number;
  reviewed_definition?: string;
  idempotency_key?: string;
}

function humanizeChanges(changes: SchemaChange[]): string[] {
  return changes.map((c) => {
    switch (c.kind) {
      case "definition-changed":
        return `Changed definition: ${c.path}`;
      case "work-unit-added":
        return `Added work-unit type: ${c.unitType}`;
      case "work-unit-removed":
        return `Removed work-unit type: ${c.unitType}`;
      case "field-added":
        return `Added field '${c.fieldName}' to ${c.unitType}`;
      case "field-removed":
        return `Removed field '${c.fieldName}' from ${c.unitType}`;
      case "field-required-added":
        return `Added required field '${c.fieldName}' to ${c.unitType}`;
      case "artifact-kind-added":
        return `Added artifact kind: ${c.artifactKind}`;
      case "artifact-kind-removed":
        return `Removed artifact kind: ${c.artifactKind}`;
      case "record-type-added":
        return `Added record type: ${c.typeName}`;
      case "record-type-removed":
        return `Removed record type: ${c.typeName}`;
      case "record-field-added":
        return `Added field '${c.fieldName}' to record type ${c.typeName}`;
      case "record-field-removed":
        return `Removed field '${c.fieldName}' from record type ${c.typeName}`;
      case "record-field-required-added":
        return `Added required field '${c.fieldName}' to record type ${c.typeName}`;
    }
  });
}

function buildHint(changes: string[]): string {
  const destructive = changes.filter(
    (c) =>
      c.startsWith("Removed") ||
      c.startsWith("Added required") ||
      c.startsWith("Changed"),
  );
  const lines = destructive.map((c) => `  - ${c}`).join("\n");
  return `Destructive changes detected:\n${lines}\n\nRe-run with --strategy=relax (enforce only for new writes) or --strategy=force (apply regardless).`;
}

export function getCurrentSchema(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
): SchemaHistory | null {
  const row = db
    .select()
    .from(schema.schemaHistory)
    .orderBy(desc(schema.schemaHistory.version))
    .limit(1)
    .get();

  if (!row) return null;

  return {
    version: row.version,
    definition: row.definition,
    applied_at: row.applied_at,
    applied_by: row.applied_by,
  };
}

export function getSchemaByVersion(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  version: number,
): SchemaHistory | null {
  const row = db
    .select()
    .from(schema.schemaHistory)
    .where(eq(schema.schemaHistory.version, version))
    .get();

  if (!row) return null;

  return {
    version: row.version,
    definition: row.definition,
    applied_at: row.applied_at,
    applied_by: row.applied_by,
  };
}

export function applySchema(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  definition: string,
  appliedBy: string,
  strategy?: string,
  origin?: RequestOrigin,
  options: SchemaApplyOptions = {},
): ApplySchemaResult {
  assertWritableDefinition(definition, options.reviewed_definition);
  SchemaApplyRequestSchema.parse({
    definition,
    strategy,
    expected_revision: options.expected_revision,
    reviewed_definition: options.reviewed_definition,
  });
  // Step 1: Validate incoming TOML (throws SchemaParseException on invalid)
  const nextParsed = parseTilaSchemaToml(definition);

  return db.transaction((tx) => {
    // A cached legacy receipt cannot bypass the now-managed precondition.
    if (
      options.expected_revision === undefined &&
      tx
        .select()
        .from(schema.queuePolicy)
        .where(eq(schema.queuePolicy.singleton, 1))
        .get()?.revision_required
    )
      throw new SchemaPreconditionError(
        "schema-revision-required",
        getCurrentSchema(tx)?.version ?? 0,
      );
    return withDoIdempotency<ApplySchemaResult>(
      tx,
      options.idempotency_key
        ? {
            key: `schema:${canonicalJson([origin?.principalId ?? appliedBy, origin?.participantId ?? appliedBy, options.idempotency_key])}`,
            requestHash: canonicalJson([
              definition,
              strategy ?? null,
              options.expected_revision ?? null,
              options.reviewed_definition ?? null,
            ]),
            shouldStore: (result) => result.ok || result.reason === "no-change",
          }
        : undefined,
      () => {
        // Step 2: Fetch current schema
        const currentRow = tx
          .select()
          .from(schema.schemaHistory)
          .orderBy(desc(schema.schemaHistory.version))
          .limit(1)
          .get();

        const revision = currentRow?.version ?? 0;
        if (
          options.expected_revision !== undefined &&
          options.expected_revision !== revision
        ) {
          throw new SchemaPreconditionError(
            "schema-revision-conflict",
            revision,
          );
        }
        if (
          options.reviewed_definition !== undefined &&
          canonicalJson(parseTilaSchemaToml(options.reviewed_definition)) !==
            canonicalJson(nextParsed)
        ) {
          throw new SchemaPreconditionError("schema-review-mismatch", revision);
        }

        let changeSummary: string[] = [];
        let diffAutoApplicable = true;
        let prevParsed: ReturnType<typeof parseTilaSchemaToml> | null = null;

        if (currentRow) {
          // Step 3: Diff against previous schema
          prevParsed = parseTilaSchemaToml(currentRow.definition);
          const diff = diffSchemas(prevParsed, nextParsed);

          // Step 4: No-change detection
          if (diff.changes.length === 0) {
            return {
              ok: false as const,
              reason: "no-change" as const,
              revision,
            };
          }

          changeSummary = humanizeChanges(diff.changes);
          diffAutoApplicable = diff.autoApplicable;

          if (
            !diffAutoApplicable &&
            strategy &&
            options.expected_revision !== undefined &&
            options.reviewed_definition === undefined
          ) {
            throw new SchemaPreconditionError(
              "schema-review-required",
              revision,
            );
          }

          // Step 5: Reject destructive without strategy
          if (!diffAutoApplicable && !strategy) {
            return {
              ok: false as const,
              reason: "destructive" as const,
              changes: changeSummary,
              hint: buildHint(changeSummary),
            };
          }
        } else {
          // First schema ever — no diff needed
          changeSummary = ["Initial schema applied"];
        }

        // Step 6: Compute new version
        const current = tx
          .select({ maxVersion: sql<number>`COALESCE(MAX(version), 0)` })
          .from(schema.schemaHistory)
          .get();

        const newVersion = (current?.maxVersion ?? 0) + 1;
        const now = Date.now();

        // Step 7: Insert with new columns
        tx.insert(schema.schemaHistory)
          .values({
            version: newVersion,
            definition,
            applied_at: now,
            applied_by: appliedBy,
            change_summary: JSON.stringify(changeSummary),
            strategy: strategy ?? null,
          })
          .run();

        // Step 7b: Search titles follow presentation metadata.
        refreshPresentedSearchTitles(tx, prevParsed, nextParsed);

        // Step 8: Emit journal event
        const journalOrigin = origin ?? {
          principalId: "system:schema",
          participantId: "system:schema",
          environment: {},
          actor: appliedBy,
        };
        appendJournal(tx, {
          kind: "schema.applied",
          resource: "schema",
          ...journalOrigin,
          actor: appliedBy,
          fence: null,
          data: { version: newVersion, changes: changeSummary },
          tokenId: origin?.tokenId,
          source: origin?.source,
          sourceVersion: origin?.sourceVersion,
        });

        // Step 9: Return result
        return {
          ok: true as const,
          version: newVersion,
          revision: newVersion,
          changes: changeSummary,
        };
      },
    ).result;
  });
}

export function listSchemaHistory(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  limit = 50,
  before?: number,
): SchemaHistory[] {
  return db
    .select()
    .from(schema.schemaHistory)
    .where(
      before === undefined
        ? undefined
        : lt(schema.schemaHistory.version, before),
    )
    .orderBy(desc(schema.schemaHistory.version))
    .limit(Math.max(1, Math.min(250, limit)))
    .all();
}

/**
 * Preview the impact of applying a new schema definition without persisting it.
 *
 * Returns the diff changes enriched with actual database counts for removal
 * operations so callers can assess destructive impact before committing.
 *
 * Note on field-removed counts: `json_extract` treats both absent keys and
 * JSON null values as SQL NULL. Counts for `field-removed` changes may slightly
 * undercount entities where the field value is explicitly set to JSON null.
 *
 * @throws {SchemaParseException} if `definition` is not valid TOML or does not
 *   conform to the tila schema format.
 */
export function previewSchema(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  definition: string,
): PreviewSchemaResult {
  assertWritableDefinition(definition);
  return db.transaction((tx) => previewSchemaInTransaction(tx, definition));
}

function previewSchemaInTransaction(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  definition: string,
): PreviewSchemaResult {
  // Validate incoming TOML (throws SchemaParseException on invalid)
  const nextParsed = parseTilaSchemaToml(definition);

  // Fetch current schema
  const currentRow = db
    .select()
    .from(schema.schemaHistory)
    .orderBy(desc(schema.schemaHistory.version))
    .limit(1)
    .get();

  // No current schema — nothing to diff
  if (!currentRow) {
    return {
      revision: 0,
      reviewed_definition: definition,
      changes: [],
      autoApplicable: true,
    };
  }

  const prevParsed = parseTilaSchemaToml(currentRow.definition);
  const diff = diffSchemas(prevParsed, nextParsed);

  const enriched = diff.changes.map((change) =>
    enrichPreviewChange(db, change, prevParsed, nextParsed),
  );

  return {
    revision: currentRow.version,
    reviewed_definition: definition,
    changes: enriched,
    autoApplicable: diff.autoApplicable,
  };
}

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

function countEntities(db: Db, type: string, archived: 0 | 1, where?: SQL) {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.type, type),
          eq(schema.entities.archived, archived),
          where,
        ),
      )
      .get()?.count ?? 0
  );
}

function countRecords(db: Db, type: string, archived: 0 | 1, where?: SQL) {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.records)
      .where(
        and(
          eq(schema.records.type, type),
          eq(schema.records.archived, archived),
          where,
        ),
      )
      .get()?.count ?? 0
  );
}

/** Rows whose JSON column has (or lacks) a non-null value at `field`. */
function jsonKey(
  column: typeof schema.entities.data | typeof schema.records.value_json,
  field: string,
  present: boolean,
): SQL {
  return present
    ? sql`json_extract(${column}, ${`$.${field}`}) IS NOT NULL`
    : sql`json_extract(${column}, ${`$.${field}`}) IS NULL`;
}

function liveArtifacts(db: Db, kind: string): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.artifactPointers)
      .where(
        and(
          eq(schema.artifactPointers.kind, kind),
          eq(schema.artifactPointers.tombstoned, 0),
        ),
      )
      .get()?.count ?? 0
  );
}

function artifactPolicyImpact(
  db: Db,
  kind: string,
  before: NonNullable<TilaSchemaToml["artifacts"]>[string],
  after: NonNullable<TilaSchemaToml["artifacts"]>[string],
): ArtifactPolicyImpact {
  const impact: ArtifactPolicyImpact = {
    liveArtifacts: liveArtifacts(db, kind),
    searchChanged:
      before.searchable !== after.searchable ||
      before.search_mode !== after.search_mode,
  };
  if (before.retention_days !== after.retention_days) {
    const pending =
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.artifactRevisions)
        .innerJoin(
          schema.artifactLineages,
          eq(schema.artifactLineages.id, schema.artifactRevisions.lineage_id),
        )
        .where(
          and(
            eq(schema.artifactLineages.kind, kind),
            eq(schema.artifactRevisions.retention_assigned, 0),
          ),
        )
        .get()?.count ?? 0;
    const snapshot = db.select().from(schema.artifactRetentionState).get();
    impact.retention = {
      from: before.retention_days,
      to: after.retention_days,
      pendingBackfill: pending,
      pendingBackfillUsesNewPolicy: !snapshot,
    };
  }
  return impact;
}

function enrichPreviewChange(
  db: Db,
  change: SchemaChange,
  previous: TilaSchemaToml,
  next: TilaSchemaToml,
): PreviewSchemaChange {
  switch (change.kind) {
    case "work-unit-removed":
      return {
        ...change,
        entityCount: countEntities(db, change.unitType, 0),
        archivedCount: countEntities(db, change.unitType, 1),
      };
    case "field-removed":
      return {
        ...change,
        entityCount: countEntities(
          db,
          change.unitType,
          0,
          jsonKey(schema.entities.data, change.fieldName, true),
        ),
      };
    case "field-added":
      if (change.declaration.default_for_legacy === undefined) return change;
      return {
        ...change,
        legacyDefaultCount: countEntities(
          db,
          change.unitType,
          0,
          jsonKey(schema.entities.data, change.fieldName, false),
        ),
      };
    case "record-type-removed":
      return {
        ...change,
        recordCount: countRecords(db, change.typeName, 0),
        archivedCount: countRecords(db, change.typeName, 1),
      };
    case "record-field-removed":
      return {
        ...change,
        recordCount: countRecords(
          db,
          change.typeName,
          0,
          jsonKey(schema.records.value_json, change.fieldName, true),
        ),
      };
    case "record-field-added":
      if (change.declaration.default_for_legacy === undefined) return change;
      return {
        ...change,
        legacyDefaultCount: countRecords(
          db,
          change.typeName,
          0,
          jsonKey(schema.records.value_json, change.fieldName, false),
        ),
      };
    case "artifact-kind-removed":
      return {
        ...change,
        artifactCount: liveArtifacts(db, change.artifactKind),
        lineageCount:
          db
            .select({ count: sql<number>`count(*)` })
            .from(schema.artifactLineages)
            .where(
              and(
                eq(schema.artifactLineages.kind, change.artifactKind),
                isNull(schema.artifactLineages.destroyed_at),
              ),
            )
            .get()?.count ?? 0,
      };
    case "definition-changed": {
      const kind = change.path.startsWith("artifacts.")
        ? change.path.slice("artifacts.".length)
        : undefined;
      const before = kind ? previous.artifacts?.[kind] : undefined;
      const after = kind ? next.artifacts?.[kind] : undefined;
      if (!kind || !before || !after) return change;
      return {
        ...change,
        impact: artifactPolicyImpact(db, kind, before, after),
      };
    }
    default:
      return change;
  }
}
