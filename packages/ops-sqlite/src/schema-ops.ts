import {
  type SchemaChange,
  type SchemaFieldChange,
  SchemaParseException,
  type SchemaRecordChange,
  diffSchemas,
  parseTilaSchemaToml,
} from "@tila/core";
import type { SchemaHistory } from "@tila/schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { type RequestOrigin, appendJournal } from "./journal-ops";
import * as schema from "./schema";

export { SchemaParseException };

/**
 * A schema change enriched with database impact counts.
 * Removal changes carry actual row counts from the database;
 * all other change kinds pass through unmodified.
 *
 * Note: `field-removed` entityCount uses `json_extract` to detect key presence.
 * `json_extract` returns SQL NULL for both "key absent" and "value is JSON null",
 * so impact counts may slightly undercount entities where the field value is
 * explicitly set to null.
 */
export type PreviewSchemaChange =
  | Exclude<
      SchemaChange,
      | { kind: "work-unit-removed" }
      | { kind: "field-removed" }
      | { kind: "record-type-removed" }
      | { kind: "record-field-removed" }
    >
  | { kind: "work-unit-removed"; unitType: string; entityCount: number }
  | {
      kind: "field-removed";
      unitType: string;
      fieldName: string;
      entityCount: number;
    }
  | {
      kind: "record-type-removed";
      typeName: string;
      recordCount: number;
    }
  | {
      kind: "record-field-removed";
      typeName: string;
      fieldName: string;
    };

export type PreviewSchemaResult = {
  changes: PreviewSchemaChange[];
  autoApplicable: boolean;
};

export type ApplySchemaResult =
  | { ok: true; version: number; changes: string[] }
  | { ok: false; reason: "no-change" }
  | { ok: false; reason: "destructive"; changes: string[]; hint: string };

function humanizeChanges(changes: SchemaChange[]): string[] {
  return changes.map((c) => {
    switch (c.kind) {
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
    (c) => c.startsWith("Removed") || c.startsWith("Added required"),
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
): ApplySchemaResult {
  // Step 1: Validate incoming TOML (throws SchemaParseException on invalid)
  const nextParsed = parseTilaSchemaToml(definition);

  return db.transaction((tx) => {
    // Step 2: Fetch current schema
    const currentRow = tx
      .select()
      .from(schema.schemaHistory)
      .orderBy(desc(schema.schemaHistory.version))
      .limit(1)
      .get();

    let changeSummary: string[] = [];
    let diffAutoApplicable = true;

    if (currentRow) {
      // Step 3: Diff against previous schema
      const prevParsed = parseTilaSchemaToml(currentRow.definition);
      const diff = diffSchemas(prevParsed, nextParsed);

      // Step 4: No-change detection
      if (diff.changes.length === 0) {
        return { ok: false as const, reason: "no-change" as const };
      }

      changeSummary = humanizeChanges(diff.changes);
      diffAutoApplicable = diff.autoApplicable;

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

    // Step 8: Emit journal event
    appendJournal(tx, {
      kind: "schema.applied",
      resource: "schema",
      actor: appliedBy,
      fence: null,
      data: { version: newVersion, changes: changeSummary },
      tokenId: origin?.tokenId,
      source: origin?.source,
      sourceVersion: origin?.sourceVersion,
    });

    // Step 9: Return result
    return { ok: true as const, version: newVersion, changes: changeSummary };
  });
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
    return { changes: [], autoApplicable: true };
  }

  const prevParsed = parseTilaSchemaToml(currentRow.definition);
  const diff = diffSchemas(prevParsed, nextParsed);

  // Enrich each change with DB counts for removal operations
  const enriched: PreviewSchemaChange[] = diff.changes.map((change) => {
    switch (change.kind) {
      case "work-unit-removed": {
        const row = db
          .select({ count: sql<number>`count(*)` })
          .from(schema.entities)
          .where(
            and(
              eq(schema.entities.type, change.unitType),
              eq(schema.entities.archived, 0),
            ),
          )
          .get();
        return {
          kind: "work-unit-removed",
          unitType: change.unitType,
          entityCount: row?.count ?? 0,
        };
      }

      case "field-removed": {
        const fieldPath = `$.${change.fieldName}`;
        const row = db
          .select({ count: sql<number>`count(*)` })
          .from(schema.entities)
          .where(
            and(
              eq(schema.entities.type, change.unitType),
              sql`json_extract(${schema.entities.data}, ${fieldPath}) IS NOT NULL`,
              eq(schema.entities.archived, 0),
            ),
          )
          .get();
        return {
          kind: "field-removed",
          unitType: change.unitType,
          fieldName: change.fieldName,
          entityCount: row?.count ?? 0,
        };
      }

      case "record-type-removed": {
        const row = db
          .select({ count: sql<number>`count(*)` })
          .from(schema.records)
          .where(
            and(
              eq(schema.records.type, change.typeName),
              eq(schema.records.archived, 0),
            ),
          )
          .get();
        return {
          kind: "record-type-removed",
          typeName: change.typeName,
          recordCount: row?.count ?? 0,
        };
      }

      default:
        return change as PreviewSchemaChange;
    }
  });

  return { changes: enriched, autoApplicable: diff.autoApplicable };
}
