import type {
  ArtifactRelationship,
  ArtifactRelationshipType,
  EntityArtifactReference,
  EntityRelationship,
  EntityRelationshipType,
} from "@tila/schemas";
import { type SQL, and, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// entity_relationships
// ---------------------------------------------------------------------------

export function insertEntityRelationship(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    from_id: string;
    to_id: string;
    type: string;
    schema_version: number;
  },
  actor: string,
): { created: boolean } {
  const now = Date.now();
  let created = false;
  db.transaction((tx) => {
    // Determine novelty via a pre-SELECT existence check rather than SQLite
    // changes(): changes() is not reported consistently across the DO SQLite
    // and bun:sqlite Drizzle drivers, whereas a SELECT on the composite PK is.
    const existing = tx
      .select({ from_id: schema.entityRelationships.from_id })
      .from(schema.entityRelationships)
      .where(
        and(
          eq(schema.entityRelationships.from_id, input.from_id),
          eq(schema.entityRelationships.to_id, input.to_id),
          eq(schema.entityRelationships.type, input.type),
        ),
      )
      .get();
    if (existing) {
      created = false;
      return;
    }

    tx.insert(schema.entityRelationships)
      .values({
        from_id: input.from_id,
        to_id: input.to_id,
        type: input.type,
        schema_version: input.schema_version,
        created_at: now,
      })
      .run();
    created = true;

    tx.run(
      sql`INSERT INTO journal (t, kind, resource, actor, fence, data) VALUES (${now}, ${"relationship.entity.created"}, ${input.from_id}, ${actor}, ${null}, ${JSON.stringify({ to_id: input.to_id, type: input.type })})`,
    );
  });
  return { created };
}

export function listEntityRelationships(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  filter?: { from_id?: string; to_id?: string; type?: string },
): EntityRelationship[] {
  const conditions: SQL[] = [];
  if (filter?.from_id) {
    conditions.push(eq(schema.entityRelationships.from_id, filter.from_id));
  }
  if (filter?.to_id) {
    conditions.push(eq(schema.entityRelationships.to_id, filter.to_id));
  }
  if (filter?.type) {
    conditions.push(eq(schema.entityRelationships.type, filter.type));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select()
    .from(schema.entityRelationships)
    .where(whereClause)
    .all();

  return rows.map((r) => ({
    from_id: r.from_id,
    to_id: r.to_id,
    // Drizzle infers text columns as `string`; cast to the Zod enum type here.
    // The DB enforces no enum constraint at the column level, so values outside
    // the enum are theoretically possible but should not occur in practice.
    // This cast is consistent with the entity-ops.ts pattern (JSON.parse as cast).
    type: r.type as EntityRelationshipType,
    schema_version: r.schema_version,
    created_at: r.created_at,
  }));
}

export function deleteEntityRelationship(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  from_id: string,
  to_id: string,
  type: string,
  actor: string,
): { removed: boolean } {
  const now = Date.now();
  let removed = false;
  db.transaction((tx) => {
    // Pre-SELECT existence check for a driver-agnostic `removed` flag
    // (see insertEntityRelationship for why changes() is not used).
    const existing = tx
      .select({ from_id: schema.entityRelationships.from_id })
      .from(schema.entityRelationships)
      .where(
        and(
          eq(schema.entityRelationships.from_id, from_id),
          eq(schema.entityRelationships.to_id, to_id),
          eq(schema.entityRelationships.type, type),
        ),
      )
      .get();
    if (!existing) {
      removed = false;
      return;
    }

    tx.delete(schema.entityRelationships)
      .where(
        and(
          eq(schema.entityRelationships.from_id, from_id),
          eq(schema.entityRelationships.to_id, to_id),
          eq(schema.entityRelationships.type, type),
        ),
      )
      .run();
    removed = true;

    tx.run(
      sql`INSERT INTO journal (t, kind, resource, actor, fence, data) VALUES (${now}, ${"relationship.entity.deleted"}, ${from_id}, ${actor}, ${null}, ${JSON.stringify({ to_id, type })})`,
    );
  });
  return { removed };
}

// ---------------------------------------------------------------------------
// entity_artifact_references
// ---------------------------------------------------------------------------

export function insertEntityArtifactReference(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    entity_id: string;
    artifact_key: string;
    slot: string;
    metadata?: Record<string, unknown>;
  },
  actor: string,
): void {
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(schema.entityArtifactReferences)
      .values({
        entity_id: input.entity_id,
        artifact_key: input.artifact_key,
        slot: input.slot,
        metadata: JSON.stringify(input.metadata ?? {}),
        created_at: now,
      })
      .run();

    tx.run(
      sql`INSERT INTO journal (t, kind, resource, actor, fence, data) VALUES (${now}, ${"reference.entity_artifact.created"}, ${input.entity_id}, ${actor}, ${null}, ${JSON.stringify({ artifact_key: input.artifact_key, slot: input.slot })})`,
    );
  });
}

export function listEntityArtifactReferences(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  filter?: { entity_id?: string; artifact_key?: string },
): EntityArtifactReference[] {
  const conditions: SQL[] = [];
  if (filter?.entity_id) {
    conditions.push(
      eq(schema.entityArtifactReferences.entity_id, filter.entity_id),
    );
  }
  if (filter?.artifact_key) {
    conditions.push(
      eq(schema.entityArtifactReferences.artifact_key, filter.artifact_key),
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select()
    .from(schema.entityArtifactReferences)
    .where(whereClause)
    .all();

  return rows.map((r) => ({
    entity_id: r.entity_id,
    artifact_key: r.artifact_key,
    slot: r.slot,
    metadata: JSON.parse(r.metadata ?? "{}") as Record<string, unknown>,
    created_at: r.created_at,
  }));
}

export function deleteEntityArtifactReference(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  entity_id: string,
  artifact_key: string,
  slot: string,
  actor: string,
): void {
  const now = Date.now();
  db.transaction((tx) => {
    tx.delete(schema.entityArtifactReferences)
      .where(
        and(
          eq(schema.entityArtifactReferences.entity_id, entity_id),
          eq(schema.entityArtifactReferences.artifact_key, artifact_key),
          eq(schema.entityArtifactReferences.slot, slot),
        ),
      )
      .run();

    tx.run(
      sql`INSERT INTO journal (t, kind, resource, actor, fence, data) VALUES (${now}, ${"reference.entity_artifact.deleted"}, ${entity_id}, ${actor}, ${null}, ${JSON.stringify({ artifact_key, slot })})`,
    );
  });
}

// ---------------------------------------------------------------------------
// artifact_relationships
// ---------------------------------------------------------------------------

export function insertArtifactRelationship(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  input: {
    from_key: string;
    to_key?: string;
    to_uri?: string;
    type: string;
    metadata?: Record<string, unknown>;
  },
  actor: string,
): void {
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(schema.artifactRelationships)
      .values({
        from_key: input.from_key,
        to_key: input.to_key ?? null,
        to_uri: input.to_uri ?? null,
        type: input.type,
        target: (input.to_key ?? input.to_uri) as string,
        metadata: JSON.stringify(input.metadata ?? {}),
        created_at: now,
      })
      .run();

    tx.run(
      sql`INSERT INTO journal (t, kind, resource, actor, fence, data) VALUES (${now}, ${"relationship.artifact.created"}, ${input.from_key}, ${actor}, ${null}, ${JSON.stringify({ to_key: input.to_key ?? null, to_uri: input.to_uri ?? null, type: input.type })})`,
    );
  });
}

export function listArtifactRelationships(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  filter?: { from_key?: string; type?: string },
): ArtifactRelationship[] {
  const conditions: SQL[] = [];
  if (filter?.from_key) {
    conditions.push(eq(schema.artifactRelationships.from_key, filter.from_key));
  }
  if (filter?.type) {
    conditions.push(eq(schema.artifactRelationships.type, filter.type));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select()
    .from(schema.artifactRelationships)
    .where(whereClause)
    .all();

  return rows.map((r) => ({
    from_key: r.from_key,
    to_key: r.to_key ?? null,
    to_uri: r.to_uri ?? null,
    // Drizzle infers text columns as `string`; cast to the Zod enum type here.
    // Same pattern as listEntityRelationships above -- acknowledges the DB may
    // store values outside the enum but treats that as a data integrity issue.
    type: r.type as ArtifactRelationshipType,
    metadata: JSON.parse(r.metadata ?? "{}") as Record<string, unknown>,
    created_at: r.created_at,
  }));
}

export function deleteArtifactRelationship(
  db: BaseSQLiteDatabase<"sync", unknown, typeof schema>,
  from_key: string,
  to_key_or_uri: string,
  type: string,
  actor: string,
): void {
  const now = Date.now();
  db.transaction((tx) => {
    // The PK is (from_key, COALESCE(to_key, to_uri), type).
    // We try matching to_key first, then to_uri (OR semantics).
    // Edge case limitation: if both to_key AND to_uri are NULL on a row, this
    // WHERE clause will delete nothing because `NULL = ?` is never true in SQL.
    // Such a row would have been inserted with COALESCE(NULL, NULL) = NULL as
    // its PK component, which is technically distinct from any non-NULL value.
    // T6 should assess whether to add a separate DELETE path for the NULL case,
    // or enforce at insert time that at least one of to_key/to_uri is non-NULL.
    tx.run(
      sql`DELETE FROM artifact_relationships WHERE from_key = ${from_key} AND type = ${type} AND (to_key = ${to_key_or_uri} OR to_uri = ${to_key_or_uri})`,
    );

    tx.run(
      sql`INSERT INTO journal (t, kind, resource, actor, fence, data) VALUES (${now}, ${"relationship.artifact.deleted"}, ${from_key}, ${actor}, ${null}, ${JSON.stringify({ target: to_key_or_uri, type })})`,
    );
  });
}
