import { validatedWrite } from "@tila/core";
import {
  type RequestOrigin,
  artifactOps,
  constraintOps,
  coordinationOps,
  entityOps,
  journalOps,
  readyOps,
  relationshipOps,
  schema,
  schemaOps,
} from "@tila/ops-sqlite";
import { ArchiveRequestSchema, UpdateEntityRequestSchema } from "@tila/schemas";
import { eq, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { filterFields } from "./entity-response";
import { formatZodIssues, jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

const {
  checkEntityTypeDeclared,
  checkLeafRejection,
  checkReferenceSlotDeclared,
  resolveCurrentSchema,
} = constraintOps;

export function createEntityRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/entity/create", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      id: string;
      type: string;
      data: Record<string, unknown>;
      created_by: string;
      schema_version?: number;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
      tags?: string[];
    };

    const parsedSchema = resolveCurrentSchema(db);
    if (parsedSchema) {
      const typeCheck = checkEntityTypeDeclared(parsedSchema, body.type);
      if (!typeCheck.ok) {
        return jsonError(c, 422, typeCheck.code, typeCheck.message);
      }
      const writeCheck = validatedWrite(body.data, parsedSchema, body.type);
      if (!writeCheck.ok) {
        return jsonError(
          c,
          422,
          "constraint-violation",
          writeCheck.errors.join("; "),
        );
      }
    }

    const origin: RequestOrigin = {
      actor: body.created_by,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    entityOps.create(
      db,
      {
        id: body.id,
        type: body.type,
        data: body.data,
        created_by: body.created_by,
        tags: body.tags,
      },
      body.schema_version ?? schemaOps.getCurrentSchema(db)?.version ?? 1,
      origin,
    );
    const entity = entityOps.get(db, body.id, deps.enrichOpts());
    return c.json({ ok: true, entity });
  });

  app.get("/entity/get/:id", (c) => {
    const { db } = deps;
    const id = c.req.param("id");
    const entity = entityOps.get(db, id, deps.enrichOpts());
    if (!entity) {
      return jsonError(c, 404, "not-found", `Entity ${id} not found`);
    }

    const compact = c.req.query("compact") === "true";
    if (compact) {
      const activeClaims = coordinationOps.listClaims(db);
      return c.json({
        ok: true,
        entity: entityOps.compactEntity(db, entity, activeClaims),
      });
    }

    const fieldsParam = c.req.query("fields");
    if (fieldsParam) {
      const fields = fieldsParam.split(",").map((f) => f.trim());
      return c.json({
        ok: true,
        entity: filterFields(entity, fields),
      });
    }

    const relationships = db
      .select()
      .from(schema.entityRelationships)
      .where(
        or(
          eq(schema.entityRelationships.from_id, id),
          eq(schema.entityRelationships.to_id, id),
        ),
      )
      .all();
    return c.json({ ok: true, entity, relationships });
  });

  app.get("/entity/list", (c) => {
    const { db } = deps;
    const typeRaw = c.req.query("type");
    const type = typeRaw?.includes(",")
      ? typeRaw.split(",").filter(Boolean)
      : (typeRaw ?? undefined);
    const archivedParam = c.req.query("archived");
    const archived =
      archivedParam !== undefined
        ? (Number(archivedParam) as 0 | 1)
        : undefined;
    const dataFilter: Record<string, unknown> = {};
    const statusRaw = c.req.query("status");
    if (statusRaw?.includes(",")) {
      dataFilter.status = statusRaw.split(",").filter(Boolean);
    } else if (statusRaw) {
      dataFilter.status = statusRaw;
    }
    const parent = c.req.query("parent");
    if (parent) dataFilter.parent_id = parent;

    const sort = c.req.query("sort") as
      | "created_at"
      | "updated_at"
      | "type"
      | "title"
      | "status"
      | undefined;
    const order = c.req.query("order") as "asc" | "desc" | undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    const offsetParam = c.req.query("offset");
    const offset = offsetParam !== undefined ? Number(offsetParam) : 0;

    const { entities, total } = entityOps.list(
      db,
      {
        type,
        archived,
        ...(Object.keys(dataFilter).length > 0 ? { dataFilter } : {}),
        sort,
        order,
        limit,
        offset,
      },
      deps.enrichOpts(),
    );

    const paginationMeta = {
      total,
      limit: limit ?? null,
      offset,
      has_more: limit !== undefined ? offset + limit < total : false,
    };

    const compact = c.req.query("compact") === "true";
    if (compact) {
      const activeClaims = coordinationOps.listClaims(db);
      return c.json({
        ok: true as const,
        entities: entities.map((e) =>
          entityOps.compactEntity(db, e, activeClaims),
        ),
        ...paginationMeta,
      });
    }

    const fieldsParam = c.req.query("fields");
    if (fieldsParam) {
      const fields = fieldsParam.split(",").map((f) => f.trim());
      return c.json({
        ok: true as const,
        entities: entities.map((e) => filterFields(e, fields)),
        ...paginationMeta,
      });
    }

    return c.json({ ok: true as const, entities, ...paginationMeta });
  });

  app.get("/entity/ready", (c) => {
    const { db } = deps;
    const type = c.req.query("type") ?? undefined;
    const parent = c.req.query("parent") ?? undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    const includeSoftBlockedParam = c.req.query("include-soft-blocked");
    const includeSoftBlocked = includeSoftBlockedParam === "true";

    try {
      const entities = readyOps.computeReadyEntities(db, {
        type,
        parent,
        limit,
        includeSoftBlocked,
      });
      return c.json({ ok: true, entities });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Invalid limit")) {
        return jsonError(c, 400, "validation-error", err.message);
      }
      throw err;
    }
  });

  app.post("/entity/update/:id", async (c) => {
    const { db } = deps;
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = UpdateEntityRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    const origin: RequestOrigin = {
      actor: (body as { actor?: string }).actor ?? "unknown",
      tokenId:
        (body as { actor_token_id?: string | null }).actor_token_id ?? null,
      source: (body as { source?: string | null }).source ?? null,
      sourceVersion:
        (body as { source_version?: string | null }).source_version ?? null,
    };
    const entity = entityOps.update(
      db,
      id,
      parsed.data.data,
      parsed.data.fence,
      origin,
      (parsed.data as { tags?: string[] }).tags,
    );
    return c.json({ ok: true, entity });
  });

  app.post("/entity/archive/:id", async (c) => {
    const { db } = deps;
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = ArchiveRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    const origin: RequestOrigin = {
      actor: (body as { actor?: string }).actor ?? "unknown",
      tokenId:
        (body as { actor_token_id?: string | null }).actor_token_id ?? null,
      source: (body as { source?: string | null }).source ?? null,
      sourceVersion:
        (body as { source_version?: string | null }).source_version ?? null,
    };
    entityOps.archive(db, id, parsed.data.fence, origin);
    return c.json({ ok: true });
  });

  app.post("/entity/relationship/create", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      from_id: string;
      to_id: string;
      type: string;
      actor: string;
    };
    if (!body.from_id || !body.to_id || !body.type || !body.actor) {
      return jsonError(
        c,
        400,
        "validation-error",
        "from_id, to_id, type, and actor are required",
      );
    }

    if (body.type === "parent-child") {
      const parentEntity = entityOps.get(db, body.from_id);
      if (!parentEntity) {
        return jsonError(
          c,
          404,
          "not-found",
          `Entity ${body.from_id} not found`,
        );
      }
      const parsedSchema = resolveCurrentSchema(db);
      if (parsedSchema) {
        const leafCheck = checkLeafRejection(parsedSchema, parentEntity.type);
        if (!leafCheck.ok) {
          return jsonError(c, 422, leafCheck.code, leafCheck.message);
        }
      }
    }

    const schemaRow = schemaOps.getCurrentSchema(db);
    const schemaVersion = schemaRow?.version ?? 1;
    const { created } = relationshipOps.insertEntityRelationship(
      db,
      {
        from_id: body.from_id,
        to_id: body.to_id,
        type: body.type,
        schema_version: schemaVersion,
      },
      body.actor,
    );
    return c.json({ ok: true, created }, created ? 201 : 200);
  });

  app.get("/entity/relationship/list", (c) => {
    const { db } = deps;
    const from_id = c.req.query("from_id") ?? undefined;
    const to_id = c.req.query("to_id") ?? undefined;
    const type = c.req.query("type") ?? undefined;
    const relationships = relationshipOps.listEntityRelationships(db, {
      from_id,
      to_id,
      type,
    });
    return c.json({ ok: true, relationships });
  });

  app.post("/entity/relationship/delete", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      from_id?: string;
      to_id?: string;
      type?: string;
      actor?: string;
    };
    if (!body.from_id || !body.to_id || !body.type) {
      return jsonError(
        c,
        400,
        "validation-error",
        "from_id, to_id, and type are required",
      );
    }
    const { removed } = relationshipOps.deleteEntityRelationship(
      db,
      body.from_id,
      body.to_id,
      body.type,
      body.actor ?? "unknown",
    );
    return c.json({ ok: true, removed });
  });

  app.get("/summary", (c) => {
    const { db } = deps;

    const typeCounts = db.all<{ type: string; cnt: number }>(sql`
      SELECT type, COUNT(*) as cnt FROM entities WHERE archived = 0 GROUP BY type
    `);
    const entity_counts: Record<string, number> = {};
    let entity_count = 0;
    for (const row of typeCounts) {
      entity_counts[row.type] = row.cnt;
      entity_count += row.cnt;
    }

    const statusRows = db.all<{ status: string | null; cnt: number }>(sql`
      SELECT json_extract(data, '$.status') as status, COUNT(*) as cnt
      FROM entities WHERE archived = 0 GROUP BY json_extract(data, '$.status')
    `);
    const status_counts: Record<string, number> = {};
    for (const row of statusRows) {
      const key = row.status ?? "null";
      status_counts[key] = row.cnt;
    }

    const activeClaims = coordinationOps.listClaims(db);
    const active_claims = activeClaims.length;
    const ready_count = readyOps.computeReadyEntities(db).length;
    const journalRows = journalOps.listJournal(db, { limit: 10 });
    const recent_events = journalRows.map((e) => ({
      seq: e.seq,
      t: e.t,
      kind: e.kind,
      resource: e.resource,
      actor: e.actor,
    }));
    const presenceRows = coordinationOps.listPresence(db);
    const online_machines = presenceRows.map((p) => p.machine);

    const payload = {
      entity_count,
      entity_counts,
      status_counts,
      active_claims,
      ready_count,
      online_machines,
      token_estimate: 0,
      recent_events,
    };
    const token_estimate = Math.ceil(JSON.stringify(payload).length / 4);
    payload.token_estimate = token_estimate;

    return c.json({ ok: true, project: payload });
  });

  app.get("/entity/search", (c) => {
    const { db } = deps;
    const q = c.req.query("q");
    if (!q || q.trim() === "") {
      return jsonError(c, 400, "missing-query", "q parameter is required");
    }
    const entity_type = c.req.query("entity_type") ?? undefined;
    const limitStr = c.req.query("limit");
    const parsedLimit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
    const limit =
      parsedLimit !== undefined && !Number.isNaN(parsedLimit)
        ? Math.min(parsedLimit, 100)
        : 20;

    try {
      const results = entityOps.searchEntities(db, { q, entity_type, limit });
      return c.json({ ok: true, results, total: results.length });
    } catch (err) {
      if (err instanceof artifactOps.SearchQueryError) {
        return jsonError(c, 400, "invalid-query", err.message);
      }
      throw err;
    }
  });

  app.get("/search", (c) => {
    const { db } = deps;
    const q = c.req.query("q");
    if (!q || q.trim() === "") {
      return jsonError(c, 400, "missing-query", "q parameter is required");
    }
    const limitStr = c.req.query("limit");
    const parsedLimit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
    const limit =
      parsedLimit !== undefined && !Number.isNaN(parsedLimit)
        ? Math.min(parsedLimit, 100)
        : 20;

    try {
      const results = entityOps.searchAll(db, { q, limit });
      return c.json({ ok: true, results, total: results.length });
    } catch (err) {
      if (err instanceof artifactOps.SearchQueryError) {
        return jsonError(c, 400, "invalid-query", err.message);
      }
      throw err;
    }
  });

  app.post("/entity/artifact-ref", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      entity_id: string;
      artifact_key: string;
      slot: string;
      metadata?: Record<string, unknown>;
      actor: string;
    };
    if (!body.entity_id || !body.artifact_key || !body.slot || !body.actor) {
      return jsonError(
        c,
        400,
        "validation-error",
        "entity_id, artifact_key, slot, and actor are required",
      );
    }

    const refEntity = entityOps.get(db, body.entity_id);
    if (!refEntity) {
      return jsonError(
        c,
        404,
        "not-found",
        `Entity ${body.entity_id} not found`,
      );
    }
    const refParsedSchema = resolveCurrentSchema(db);
    if (refParsedSchema) {
      const slotCheck = checkReferenceSlotDeclared(
        refParsedSchema,
        refEntity.type,
        body.slot,
      );
      if (!slotCheck.ok) {
        return jsonError(c, 422, slotCheck.code, slotCheck.message);
      }
    }

    try {
      relationshipOps.insertEntityArtifactReference(
        db,
        {
          entity_id: body.entity_id,
          artifact_key: body.artifact_key,
          slot: body.slot,
          metadata: body.metadata,
        },
        body.actor,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        return jsonError(
          c,
          404,
          "not-found",
          "Entity or artifact not found. Ensure both entity_id and artifact_key exist.",
        );
      }
      if (msg.includes("CHECK constraint failed")) {
        return jsonError(
          c,
          400,
          "bad-request",
          "CHECK constraint failed on entity_id or artifact_key",
        );
      }
      throw err;
    }
    return c.json({ ok: true }, 201);
  });

  app.get("/entity/artifact-refs", (c) => {
    const { db } = deps;
    const entityId = c.req.query("entity_id");
    if (!entityId) {
      return jsonError(c, 400, "bad-request", "entity_id query param required");
    }
    const references = relationshipOps.listEntityArtifactReferences(db, {
      entity_id: entityId,
    });
    return c.json({ ok: true, references });
  });

  return app;
}
