import type {
  Entity,
  EntityArtifactReference,
  EntityRelationship,
  JournalEvent,
} from "@tila/schemas";
import type {
  AddArtifactRefInput,
  CreateEntityInput,
  EntityBackend,
  EntityListFilter,
  EntityTree,
  ReadyFilter,
  RelationshipFilter,
  RelationshipInput,
} from "../../src/interfaces/entity-backend";

export class EntityNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Entity not found: ${id}`);
    this.name = "EntityNotFoundError";
  }
}

export class InMemoryEntityBackend implements EntityBackend {
  private entities = new Map<string, Entity>();
  private journal: JournalEvent[] = [];
  private seq = 0;

  async create(input: CreateEntityInput): Promise<Entity> {
    const now = Date.now();
    const entity: Entity = {
      id: input.id,
      type: input.type,
      schema_version: 1,
      data: input.data,
      archived: 0,
      created_at: now,
      updated_at: now,
      created_by: input.created_by,
    };
    this.entities.set(input.id, entity);
    this.appendJournal("entity.created", input.id, input.created_by, null, {});
    return entity;
  }

  async get(id: string): Promise<Entity | null> {
    return this.entities.get(id) ?? null;
  }

  async list(filter?: EntityListFilter): Promise<Entity[]> {
    let results = Array.from(this.entities.values());

    if (filter?.type !== undefined) {
      results = results.filter((e) => e.type === filter.type);
    }
    if (filter?.archived !== undefined) {
      results = results.filter((e) => e.archived === filter.archived);
    }
    if (filter?.dataFilter) {
      const dataFilter = filter.dataFilter;
      results = results.filter((e) =>
        Object.entries(dataFilter).every(
          ([key, value]) => e.data[key] === value,
        ),
      );
    }

    return results;
  }

  async update(id: string, data: Partial<Entity["data"]>): Promise<Entity> {
    const entity = this.entities.get(id);
    if (!entity) throw new EntityNotFoundError(id);

    const updated: Entity = {
      ...entity,
      data: { ...entity.data, ...data },
      updated_at: Date.now(),
    };
    this.entities.set(id, updated);
    this.appendJournal("entity.updated", id, entity.created_by, null, data);
    return updated;
  }

  async archive(id: string): Promise<void> {
    const entity = this.entities.get(id);
    if (!entity) throw new EntityNotFoundError(id);

    const archived: Entity = { ...entity, archived: 1, updated_at: Date.now() };
    this.entities.set(id, archived);
    this.appendJournal("entity.archived", id, entity.created_by, null, {});
  }

  // The methods below complete the `EntityBackend` surface so the `implements`
  // claim is honest. This fixture is an entity-only in-memory fake used by the
  // core fence/journal fixture tests; relationships, ready/tree, fenced update,
  // and artifact references are out of scope, so they throw rather than carry a
  // misleading partial implementation. (Not currently exercised — kept compilable.)

  async addRelationship(
    _input: RelationshipInput,
  ): Promise<{ created: boolean }> {
    throw new Error("not implemented");
  }

  async listRelationships(
    _filter?: RelationshipFilter,
  ): Promise<EntityRelationship[]> {
    throw new Error("not implemented");
  }

  async removeRelationship(
    _input: RelationshipInput,
  ): Promise<{ removed: boolean }> {
    throw new Error("not implemented");
  }

  async listReady(_filter?: ReadyFilter): Promise<Entity[]> {
    throw new Error("not implemented");
  }

  async tree(_rootId?: string): Promise<EntityTree> {
    throw new Error("not implemented");
  }

  async updateWithFence(
    _id: string,
    _data: Partial<Entity["data"]>,
    _fence: number,
  ): Promise<Entity> {
    throw new Error("not implemented");
  }

  async addArtifactRef(_input: AddArtifactRefInput): Promise<void> {
    throw new Error("not implemented");
  }

  async listArtifactRefs(
    _entityId: string,
  ): Promise<EntityArtifactReference[]> {
    throw new Error("not implemented");
  }

  /** Test-only accessor. NOT part of the EntityBackend interface. */
  getJournal(): JournalEvent[] {
    return [...this.journal];
  }

  private appendJournal(
    kind: JournalEvent["kind"],
    resource: string,
    actor: string,
    fence: number | null,
    data: Record<string, unknown>,
  ): void {
    this.seq++;
    this.journal.push({
      seq: this.seq,
      t: Date.now(),
      kind,
      resource,
      actor,
      fence,
      data,
    });
  }
}
