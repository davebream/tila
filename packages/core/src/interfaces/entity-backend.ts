import type {
  CompactEntity,
  Entity,
  EntityArtifactReference,
  EntityRelationship,
} from "@tila/schemas";

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
  /**
   * Filter on entity `data` fields. CONTRACT: keys are DATA-FIELD names (the
   * stored JSON keys, e.g. `parent_id`, `status`) — NOT Worker query-param
   * names. Each key is matched server-side via `json_extract(data, '$.<key>')`
   * against the scalar value (string/number/boolean; an array value means
   * `IN (...)`). `EmbeddedProject` applies these directly; `RemoteBackend`
   * translates the data-field names that differ from the Worker's list
   * query-param names (currently only `parent_id` -> the `parent` query param,
   * which the DO maps back to `dataFilter.parent_id`). Use `parent_id`, never
   * `parent`, so the single shape works against both backends.
   */
  dataFilter?: Record<string, unknown>;
  sort?: "created_at" | "updated_at" | "type" | "title" | "status";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** Options for {@link EntityBackend.listReady}, mirroring `readyOps.computeReadyEntities`. */
export interface ReadyFilter {
  type?: string;
  /** Matches `json_extract(data, '$.parent_id')`. */
  parent?: string;
  limit?: number;
  /** Include soft-blocked entities (default: false, i.e. excluded). */
  includeSoftBlocked?: boolean;
}

/** Input for {@link EntityBackend.addArtifactRef}. */
export interface AddArtifactRefInput {
  entity_id: string;
  artifact_key: string;
  slot: string;
  metadata?: Record<string, unknown>;
}

/**
 * The relationship tree for a project (or a sub-tree rooted at `rootId`).
 * `nodes` are compact entities; `edges` are the parent-child relationships
 * that connect them. Callers build the nesting from the edges.
 */
export interface EntityTree {
  nodes: CompactEntity[];
  edges: EntityRelationship[];
}

export interface EntityBackend {
  create(input: CreateEntityInput): Promise<Entity>;
  get(id: string): Promise<Entity | null>;
  /** List entities. See {@link EntityListFilter.dataFilter} for the data-field filter contract. */
  list(filter?: EntityListFilter): Promise<Entity[]>;
  update(id: string, data: Partial<Entity["data"]>): Promise<Entity>;
  archive(id: string): Promise<void>;
  addRelationship(input: RelationshipInput): Promise<{ created: boolean }>;
  listRelationships(filter?: RelationshipFilter): Promise<EntityRelationship[]>;
  removeRelationship(input: RelationshipInput): Promise<{ removed: boolean }>;

  /** Tasks whose blockers are all resolved (ready to work). */
  listReady(filter?: ReadyFilter): Promise<Entity[]>;
  /** Parent-child relationship tree (compact nodes + parent-child edges). */
  tree(rootId?: string): Promise<EntityTree>;
  /**
   * Fenced entity update: validates `fence` against the entity's claim like any
   * destructive write. Throws a fence-conflict when `fence` is stale.
   */
  updateWithFence(
    id: string,
    data: Partial<Entity["data"]>,
    fence: number,
  ): Promise<Entity>;
  /** Attach an artifact reference (entity_id, artifact_key, slot) to a task. */
  addArtifactRef(input: AddArtifactRefInput): Promise<void>;
  /** List artifact references for a task. */
  listArtifactRefs(entityId: string): Promise<EntityArtifactReference[]>;
}
