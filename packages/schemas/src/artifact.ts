import { z } from "zod";

// --- Artifact Pointers (DO SQLite: artifact_pointers) ---

export const ArtifactPointerSchema = z.object({
  r2_key: z.string(),
  resource: z.string().nullable(),
  kind: z.string(), // open set, config-defined per tila.schema.toml
  sha256: z.string(),
  bytes: z.number().int(),
  fence: z.number().int().nullable(),
  mime_type: z.string(),
  produced_at: z.number().int(),
  produced_by: z.string(),
  expires_at: z.number().int().nullable(),
  tombstoned: z.number().int().default(0),
});

export type ArtifactPointer = z.infer<typeof ArtifactPointerSchema>;

// --- Entity-Artifact References (DO SQLite: entity_artifact_references) ---

export const EntityArtifactReferenceSchema = z.object({
  entity_id: z.string(),
  artifact_key: z.string(),
  slot: z.string(),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.number().int(),
});

export type EntityArtifactReference = z.infer<
  typeof EntityArtifactReferenceSchema
>;

// --- Artifact Relationships (DO SQLite: artifact_relationships) ---

export const ArtifactRelationshipTypeSchema = z.enum([
  "references",
  "supersedes",
  "derived-from",
  "index-of",
  "entry-of",
]);

export type ArtifactRelationshipType = z.infer<
  typeof ArtifactRelationshipTypeSchema
>;

export const ArtifactRelationshipSchema = z.object({
  from_key: z.string(),
  to_key: z.string().nullable(),
  to_uri: z.string().nullable(),
  type: ArtifactRelationshipTypeSchema,
  metadata: z.record(z.unknown()).default({}),
  created_at: z.number().int(),
});

export type ArtifactRelationship = z.infer<typeof ArtifactRelationshipSchema>;

// --- Artifact Search Results (DO SQLite: artifact_search_docs + FTS5) ---

export const ArtifactSearchResultSchema = z.object({
  r2_key: z.string(),
  kind: z.string(),
  resource: z.string().nullable(),
  mime_type: z.string(),
  produced_at: z.number().int(),
  title: z.string().nullable(),
  snippet: z.string().nullable(),
  indexed_at: z.number().int(),
});

export type ArtifactSearchResult = z.infer<typeof ArtifactSearchResultSchema>;

// --- Entity Search Results (DO SQLite: entity_search_docs + FTS5) ---

export const EntitySearchResultSchema = z.object({
  entity_id: z.string(),
  entity_type: z.string(),
  name: z.string().nullable(),
  snippet: z.string().nullable(),
  indexed_at: z.number().int(),
});

export type EntitySearchResult = z.infer<typeof EntitySearchResultSchema>;
