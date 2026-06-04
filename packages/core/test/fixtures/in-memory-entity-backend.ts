import type { Entity, JournalEvent } from "@tila/schemas";
import type {
  CreateEntityInput,
  EntityBackend,
  EntityListFilter,
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
