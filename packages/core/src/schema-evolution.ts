import type { Entity, FieldDeclaration, TilaSchemaToml } from "@tila/schemas";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Tolerant read: validates entity data against the schema version it was written with.
 * Unknown fields in data are preserved (passthrough) -- not stripped.
 * Only checks fields declared in the schema; extra fields do not cause failure.
 *
 * For legacy entities (schema_version < current), required fields that have
 * `default_for_legacy` defined are exempt from the required check.
 */
export function tolerantRead(
  entity: Entity,
  schema: TilaSchemaToml,
  entityType: string,
): ValidationResult {
  const workUnit = schema.work_units[entityType];
  if (!workUnit) {
    return { ok: false, errors: [`Unknown entity type: ${entityType}`] };
  }

  const errors: string[] = [];
  const fields = workUnit.fields;

  for (const [fieldName, declaration] of Object.entries(fields) as [
    string,
    FieldDeclaration,
  ][]) {
    if (!declaration.required) continue;

    const hasValue = fieldName in entity.data;
    if (hasValue) continue;

    const hasLegacyDefault = declaration.default_for_legacy !== undefined;
    if (hasLegacyDefault) continue;

    errors.push(`Required field "${fieldName}" is missing`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Validated write: checks that data satisfies the current schema's required fields.
 * Called before writing/updating an entity to ensure new data conforms.
 * Does NOT strip unknown fields -- merge semantics, not replace.
 * Enforces all required fields regardless of schema version.
 */
export function validatedWrite(
  data: Record<string, unknown>,
  schema: TilaSchemaToml,
  entityType: string,
): ValidationResult {
  const workUnit = schema.work_units[entityType];
  if (!workUnit) {
    return { ok: false, errors: [`Unknown entity type: ${entityType}`] };
  }

  const errors: string[] = [];
  const fields = workUnit.fields;

  for (const [fieldName, declaration] of Object.entries(fields) as [
    string,
    FieldDeclaration,
  ][]) {
    if (!declaration.required) continue;

    if (!(fieldName in data)) {
      errors.push(`Required field "${fieldName}" is missing`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Applies default_for_legacy values for fields present in the schema but
 * absent from the entity's data. Returns a new Entity with enriched data.
 * Safe to call on any entity -- returns unmodified entity if no defaults apply.
 * Uses copy-on-write: the input entity is never mutated.
 */
export function applyLegacyDefaults(
  entity: Entity,
  schema: TilaSchemaToml,
  entityType: string,
): Entity {
  const workUnit = schema.work_units[entityType];
  if (!workUnit) return entity;

  const fields = workUnit.fields;
  let enriched = entity.data;

  for (const [fieldName, declaration] of Object.entries(fields) as [
    string,
    FieldDeclaration,
  ][]) {
    const missing = !(fieldName in entity.data);
    const hasDefault = declaration.default_for_legacy !== undefined;
    if (missing && hasDefault) {
      if (enriched === entity.data) {
        enriched = { ...entity.data }; // copy-on-write
      }
      enriched[fieldName] = declaration.default_for_legacy;
    }
  }

  return enriched === entity.data ? entity : { ...entity, data: enriched };
}

// --- Schema Diff Types ---

export type SchemaFieldChange =
  | {
      kind: "field-added";
      unitType: string;
      fieldName: string;
      declaration: FieldDeclaration;
    }
  | { kind: "field-removed"; unitType: string; fieldName: string }
  | {
      kind: "field-required-added";
      unitType: string;
      fieldName: string;
      declaration: FieldDeclaration;
    };

export type SchemaUnitChange =
  | { kind: "work-unit-added"; unitType: string }
  | { kind: "work-unit-removed"; unitType: string; entityCount: number };

export type SchemaArtifactChange =
  | { kind: "artifact-kind-added"; artifactKind: string }
  | {
      kind: "artifact-kind-removed";
      artifactKind: string;
      artifactCount: number;
    };

export type SchemaRecordChange =
  | { kind: "record-type-added"; typeName: string }
  | { kind: "record-type-removed"; typeName: string; recordCount: number }
  | {
      kind: "record-field-added";
      typeName: string;
      fieldName: string;
      declaration: FieldDeclaration;
    }
  | { kind: "record-field-removed"; typeName: string; fieldName: string }
  | {
      kind: "record-field-required-added";
      typeName: string;
      fieldName: string;
      declaration: FieldDeclaration;
    };

export type SchemaChange =
  | SchemaFieldChange
  | SchemaUnitChange
  | SchemaArtifactChange
  | SchemaRecordChange;

export type SchemaDiffResult = {
  changes: SchemaChange[];
  autoApplicable: boolean;
};

/**
 * Compare two TilaSchemaToml objects and produce a classified list of changes.
 * Pure function — no DB access. entityCount/artifactCount are always 0.
 * autoApplicable is true iff there are no destructive changes.
 */
export function diffSchemas(
  previous: TilaSchemaToml,
  next: TilaSchemaToml,
): SchemaDiffResult {
  const changes: SchemaChange[] = [];

  const prevUnits = Object.keys(previous.work_units);
  const nextUnits = Object.keys(next.work_units);
  const prevUnitSet = new Set(prevUnits);
  const nextUnitSet = new Set(nextUnits);

  // Work-unit additions
  for (const unitType of nextUnits) {
    if (!prevUnitSet.has(unitType)) {
      changes.push({ kind: "work-unit-added", unitType });
    }
  }

  // Work-unit removals
  for (const unitType of prevUnits) {
    if (!nextUnitSet.has(unitType)) {
      changes.push({ kind: "work-unit-removed", unitType, entityCount: 0 });
    }
  }

  // Field diff for units present in both
  for (const unitType of prevUnits) {
    if (!nextUnitSet.has(unitType)) continue;

    const prevFields = previous.work_units[unitType].fields as Record<
      string,
      FieldDeclaration
    >;
    const nextFields = next.work_units[unitType].fields as Record<
      string,
      FieldDeclaration
    >;
    const prevFieldNames = new Set(Object.keys(prevFields));
    const nextFieldNames = new Set(Object.keys(nextFields));

    // Added fields (net-new — not in prev)
    for (const fieldName of nextFieldNames) {
      if (!prevFieldNames.has(fieldName)) {
        const decl = nextFields[fieldName];
        // A required field added WITH default_for_legacy is non-destructive:
        // legacy rows are tolerated and the default is materialized at read
        // time (applyLegacyDefaults / tolerantRead). Only a required field
        // WITHOUT a legacy default is destructive. Use a presence check
        // (`=== undefined`) so a legitimate default of false/0/"" still counts.
        // Mirrors the record branch and the v0.1 "auto-apply with default"
        // success criterion.
        if (decl.required && decl.default_for_legacy === undefined) {
          changes.push({
            kind: "field-required-added",
            unitType,
            fieldName,
            declaration: decl,
          });
        } else {
          changes.push({
            kind: "field-added",
            unitType,
            fieldName,
            declaration: decl,
          });
        }
      }
    }

    // Removed fields (in prev, not in next)
    for (const fieldName of prevFieldNames) {
      if (!nextFieldNames.has(fieldName)) {
        changes.push({ kind: "field-removed", unitType, fieldName });
      }
    }

    // Changed fields (present in both — compare type and required)
    for (const fieldName of prevFieldNames) {
      if (!nextFieldNames.has(fieldName)) continue;
      const prevDecl = prevFields[fieldName];
      const nextDecl = nextFields[fieldName];

      const typeChanged = prevDecl.type !== nextDecl.type;
      const requiredChanged =
        (prevDecl.required ?? false) !== (nextDecl.required ?? false);

      if (typeChanged || requiredChanged) {
        // Emit as field-removed + field-added pair for changed fields.
        // The "added" side always uses field-added (not field-required-added) because
        // this is a modification of an existing field, not a brand-new required field.
        // Destructiveness is captured by field-removed.
        changes.push({ kind: "field-removed", unitType, fieldName });
        changes.push({
          kind: "field-added",
          unitType,
          fieldName,
          declaration: nextDecl,
        });
      }
    }
  }

  // Artifact diff
  const prevArtifacts = previous.artifacts ?? {};
  const nextArtifacts = next.artifacts ?? {};
  const prevKinds = new Set(Object.keys(prevArtifacts));
  const nextKinds = new Set(Object.keys(nextArtifacts));

  for (const kind of nextKinds) {
    if (!prevKinds.has(kind)) {
      changes.push({ kind: "artifact-kind-added", artifactKind: kind });
    }
  }
  for (const kind of prevKinds) {
    if (!nextKinds.has(kind)) {
      changes.push({
        kind: "artifact-kind-removed",
        artifactKind: kind,
        artifactCount: 0,
      });
    }
  }

  // Record diff
  const prevRecords = previous.records ?? {};
  const nextRecords = next.records ?? {};
  const prevRecordTypes = Object.keys(prevRecords);
  const nextRecordTypes = Object.keys(nextRecords);
  const prevRecordSet = new Set(prevRecordTypes);
  const nextRecordSet = new Set(nextRecordTypes);

  // Record type additions
  for (const typeName of nextRecordTypes) {
    if (!prevRecordSet.has(typeName)) {
      changes.push({ kind: "record-type-added", typeName });
    }
  }

  // Record type removals
  for (const typeName of prevRecordTypes) {
    if (!nextRecordSet.has(typeName)) {
      changes.push({ kind: "record-type-removed", typeName, recordCount: 0 });
    }
  }

  // Record field diff for types present in both
  for (const typeName of prevRecordTypes) {
    if (!nextRecordSet.has(typeName)) continue;
    const prevFields = prevRecords[typeName].fields as Record<
      string,
      FieldDeclaration
    >;
    const nextFields = nextRecords[typeName].fields as Record<
      string,
      FieldDeclaration
    >;
    const prevFieldNames = new Set(Object.keys(prevFields));
    const nextFieldNames = new Set(Object.keys(nextFields));

    // Added fields
    for (const fieldName of nextFieldNames) {
      if (!prevFieldNames.has(fieldName)) {
        const decl = nextFields[fieldName];
        // Presence check (`=== undefined`) so a legitimate default of
        // false/0/"" still counts as "has a default" (consistent with the
        // entity branch above and applyLegacyDefaults).
        if (decl.required && decl.default_for_legacy === undefined) {
          changes.push({
            kind: "record-field-required-added",
            typeName,
            fieldName,
            declaration: decl,
          });
        } else {
          changes.push({
            kind: "record-field-added",
            typeName,
            fieldName,
            declaration: decl,
          });
        }
      }
    }

    // Removed fields
    for (const fieldName of prevFieldNames) {
      if (!nextFieldNames.has(fieldName)) {
        changes.push({ kind: "record-field-removed", typeName, fieldName });
      }
    }

    // Changed fields (type or required changed) — emit as removed + added pair
    for (const fieldName of prevFieldNames) {
      if (!nextFieldNames.has(fieldName)) continue;
      const prevDecl = prevFields[fieldName];
      const nextDecl = nextFields[fieldName];
      const typeChanged = prevDecl.type !== nextDecl.type;
      const requiredChanged =
        (prevDecl.required ?? false) !== (nextDecl.required ?? false);
      if (typeChanged || requiredChanged) {
        changes.push({ kind: "record-field-removed", typeName, fieldName });
        changes.push({
          kind: "record-field-added",
          typeName,
          fieldName,
          declaration: nextDecl,
        });
      }
    }
  }

  // autoApplicable: true iff no destructive changes present
  const destructiveKinds = new Set([
    "work-unit-removed",
    "field-removed",
    "field-required-added",
    "artifact-kind-removed",
    "record-type-removed",
    "record-field-removed",
    "record-field-required-added",
  ]);
  const autoApplicable = !changes.some((c) => destructiveKinds.has(c.kind));

  return { changes, autoApplicable };
}
