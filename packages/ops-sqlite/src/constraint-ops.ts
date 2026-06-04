import { parseSchemaToml } from "@tila/core";
import type { TilaSchemaToml } from "@tila/schemas";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schemaModule from "./schema";
import { getCurrentSchema } from "./schema-ops";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConstraintViolation = {
  ok: false;
  code: "constraint-violation";
  message: string;
};

export type ConstraintResult = { ok: true } | ConstraintViolation;

// ---------------------------------------------------------------------------
// Schema resolution
// ---------------------------------------------------------------------------

/**
 * Fetches and parses the current schema from _schema_history.
 * Returns null when no schema is applied or when the stored definition
 * fails to parse — all constraint checks skip on null (graceful degradation).
 */
export function resolveCurrentSchema(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schemaModule>,
): TilaSchemaToml | null {
  const row = getCurrentSchema(db);
  if (!row) return null;
  const result = parseSchemaToml(row.definition);
  return result.ok ? result.schema : null;
}

// ---------------------------------------------------------------------------
// Check 1: Entity type declared
// ---------------------------------------------------------------------------

/**
 * Entity type must exist as a key in work_units.
 * Called on entity create.
 */
export function checkEntityTypeDeclared(
  schema: TilaSchemaToml,
  entityType: string,
): ConstraintResult {
  if (!(entityType in schema.work_units)) {
    return {
      ok: false,
      code: "constraint-violation",
      message: `Entity type "${entityType}" is not declared in work_units. Declared types: ${Object.keys(schema.work_units).join(", ") || "(none)"}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Check 2: Leaf rejection
// ---------------------------------------------------------------------------

/**
 * Entity types that appear as the last entry in hierarchy.levels cannot be parents.
 * Called on entity relationship create when type === "parent-child".
 *
 * When hierarchy or levels is absent/empty, no constraint applies.
 */
export function checkLeafRejection(
  schema: TilaSchemaToml,
  parentEntityType: string,
): ConstraintResult {
  const levels = schema.hierarchy?.levels;
  if (!levels || levels.length === 0) return { ok: true };
  const leafType = levels[levels.length - 1];
  if (parentEntityType === leafType) {
    return {
      ok: false,
      code: "constraint-violation",
      message: `Entity type "${parentEntityType}" is a leaf type (last entry in hierarchy.levels) and cannot have children`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Check 3: Artifact kind declared
// ---------------------------------------------------------------------------

/**
 * Artifact kind must be declared in the artifacts record.
 * Called on artifact pointer upsert.
 *
 * When artifacts section is absent, no constraint applies.
 */
export function checkArtifactKindDeclared(
  schema: TilaSchemaToml,
  kind: string,
): ConstraintResult {
  const artifacts = schema.artifacts;
  if (!artifacts) return { ok: true };
  if (!(kind in artifacts)) {
    return {
      ok: false,
      code: "constraint-violation",
      message: `Artifact kind "${kind}" is not declared in artifacts. Declared kinds: ${Object.keys(artifacts).join(", ") || "(none)"}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Check: Artifact kind searchability
// ---------------------------------------------------------------------------

export type SearchabilityResult = {
  searchable: boolean;
  search_mode: "none" | "full_text";
};

/**
 * Returns the searchability config for an artifact kind.
 * Never throws. Returns { searchable: false, search_mode: "none" } when:
 * - artifacts section is absent
 * - kind is not declared
 * Used by the /artifact/pointer handler to decide whether to write a search doc.
 */
export function checkArtifactKindSearchable(
  schema: TilaSchemaToml,
  kind: string,
): SearchabilityResult {
  const artifactKind = schema.artifacts?.[kind];
  if (!artifactKind) return { searchable: false, search_mode: "none" };
  return {
    searchable: artifactKind.searchable,
    search_mode: artifactKind.search_mode,
  };
}

// ---------------------------------------------------------------------------
// Check: Artifact kind retention
// ---------------------------------------------------------------------------

/**
 * Returns the retention_days for an artifact kind.
 * Returns 0 when:
 * - artifacts section is absent
 * - kind is not declared
 * - kind is declared with retention_days: 0 (default)
 * A return value of 0 means "no expiration" (expires_at stays null).
 * Never throws.
 */
export function getArtifactKindRetention(
  schema: TilaSchemaToml,
  kind: string,
): number {
  return schema.artifacts?.[kind]?.retention_days ?? 0;
}

// ---------------------------------------------------------------------------
// Check: Artifact kind auto-supersedes
// ---------------------------------------------------------------------------

/**
 * Returns whether auto-supersedes is enabled for an artifact kind.
 * Returns false when:
 * - artifacts section is absent
 * - kind is not declared
 * - kind is declared with auto_supersedes: false (default)
 * Never throws.
 */
export function getAutoSupersedes(
  schema: TilaSchemaToml,
  kind: string,
): boolean {
  return schema.artifacts?.[kind]?.auto_supersedes ?? false;
}

// ---------------------------------------------------------------------------
// Check 4: Artifact relationship type declared
// ---------------------------------------------------------------------------

/**
 * Artifact relationship type must be in artifact_relationships.types.
 * Called on artifact relationship insert.
 *
 * When artifact_relationships or types is absent/empty, no constraint applies.
 */
export function checkArtifactRelationshipTypeDeclared(
  schema: TilaSchemaToml,
  relationshipType: string,
): ConstraintResult {
  const types = schema.artifact_relationships?.types;
  if (!types || types.length === 0) return { ok: true };
  if (!types.includes(relationshipType)) {
    return {
      ok: false,
      code: "constraint-violation",
      message: `Artifact relationship type "${relationshipType}" is not declared in artifact_relationships.types. Declared types: ${types.join(", ")}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Check: Record type declared
// ---------------------------------------------------------------------------

/**
 * Record type must exist as a key in records.
 * Called on record create and set.
 */
export function checkRecordTypeDeclared(
  schema: TilaSchemaToml,
  recordType: string,
): ConstraintResult {
  const records = schema.records ?? {};
  if (!(recordType in records)) {
    return {
      ok: false,
      code: "constraint-violation",
      message: `Record type "${recordType}" is not declared in records. Declared types: ${Object.keys(records).join(", ") || "(none)"}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Check 5: Reference slot declared
// ---------------------------------------------------------------------------

/**
 * Entity-artifact reference slot must be declared in the entity type's
 * work_units.<type>.references list.
 *
 * When the work unit has no references declared (absent or empty), any slot
 * is permitted (open schema). When references is non-empty, slot must match
 * a declared reference name.
 */
export function checkReferenceSlotDeclared(
  schema: TilaSchemaToml,
  entityType: string,
  slot: string,
): ConstraintResult {
  const workUnit = schema.work_units[entityType];
  if (!workUnit) return { ok: true }; // entity type check catches this first
  const references = workUnit.references;
  if (!references || references.length === 0) return { ok: true };
  const declared = references.map((r) => r.name);
  if (!declared.includes(slot)) {
    return {
      ok: false,
      code: "constraint-violation",
      message: `Reference slot "${slot}" is not declared for entity type "${entityType}". Declared slots: ${declared.join(", ")}`,
    };
  }
  return { ok: true };
}
