import type { Entity, EntityRelationship } from "@tila/schemas";

export interface CreateEntityInput {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_by: string;
}

export interface RelationshipInput {
  from_id: string;
  to_id: string;
  type: string;
}

export interface RelationshipFilter {
  from_id?: string;
  to_id?: string;
  type?: string;
}

export interface EntityListFilter {
  type?: string;
  archived?: 0 | 1;
  dataFilter?: Record<string, unknown>;
  sort?: "created_at" | "updated_at" | "type" | "title" | "status";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface EntityBackend {
  create(input: CreateEntityInput): Promise<Entity>;
  get(id: string): Promise<Entity | null>;
  list(filter?: EntityListFilter): Promise<Entity[]>;
  update(id: string, data: Partial<Entity["data"]>): Promise<Entity>;
  archive(id: string): Promise<void>;
  addRelationship(input: RelationshipInput): Promise<{ created: boolean }>;
  listRelationships(filter?: RelationshipFilter): Promise<EntityRelationship[]>;
  removeRelationship(input: RelationshipInput): Promise<{ removed: boolean }>;
}
