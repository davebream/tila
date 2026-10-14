import { validatedWrite } from "@tila/core";
import { summaryOps } from "@tila/ops-sqlite";
import {
  CredentialPolicyDenied,
  assertResourceAccess,
  filterRelationships,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
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
  searchPageOps,
} from "@tila/ops-sqlite";
import {
  ArchiveRequestSchema,
  type LifecycleOutcome,
  LifecycleOutcomeSchema,
  type SearchKind,
  TaskListPageOptionsSchema,
  UpdateEntityRequestSchema,
  parseTagFilter,
} from "@tila/schemas";
import { eq, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { ZodError, z } from "zod";
import { filterFields } from "./entity-response";
import { originFromBody } from "./origin";
import {
  formatZodIssues,
  idempotencyFrom,
  jsonError,
  jsonOkRows,
} from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

const {
  checkEntityTypeDeclared,
  checkLeafRejection,
  checkReferenceSlotDeclared,
  resolveCurrentSchema,
} = constraintOps;

/** Compact titles follow presentation metadata; a corrupt schema only loses that. */
function currentSchemaOrNull(
  db: Parameters<typeof constraintOps.resolveCurrentSchema>[0],
) {
  try {
    return constraintOps.resolveCurrentSchema(db);
  } catch {
    return null;
  }
}

function currentPresentation(
  db: Parameters<typeof constraintOps.resolveCurrentSchema>[0],
  type: string,
) {
  return currentSchemaOrNull(db)?.work_units[type]?.presentation;
}

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

    const origin = originFromBody(body as Record<string, unknown>);
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
    return jsonOkRows(c, { entity }, 1);
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
      const stats = entityOps.getCompactEntityStats(db, [entity.id]);
      return c.json({
        ok: true,
        entity: entityOps.compactEntity(
          db,
          entity,
          activeClaims,
          stats,
          currentPresentation(db, entity.type),
        ),
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
    return c.json({
      ok: true,
      entity,
      relationships: filterRelationships(
        db,
        readCredentialPolicy(c.req.header("X-Tila-Credential-Policy")),
        relationships,
      ),
    });
  });

  app.get("/entity/type-counts", (c) => {
    const counts = entityOps.countByType(
      deps.db,
      readCredentialPolicy(c.req.header("X-Tila-Credential-Policy"))
        ?.restrictions,
    );
    return c.json({ ok: true, counts });
  });

  app.get("/entity/list", (c) => {
    const { db } = deps;

    let tagFilter: string[] | undefined;
    try {
      tagFilter = parseTagFilter(c.req.query("tag_filter"));
    } catch (err) {
      if (err instanceof ZodError) {
        return jsonError(
          c,
          400,
          "validation-error",
          err.issues.map((i) => i.message).join("; "),
        );
      }
      throw err;
    }

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

    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const parsedPaging = TaskListPageOptionsSchema.safeParse({
      sort: c.req.query("sort"),
      order: c.req.query("order"),
      limit: limitParam !== undefined ? Number(limitParam) : undefined,
      offset: offsetParam !== undefined ? Number(offsetParam) : 0,
      cursor: c.req.query("cursor"),
    });
    if (!parsedPaging.success)
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsedPaging.error.issues),
      );
    const { sort, order, limit, offset = 0, cursor } = parsedPaging.data;
    const restrictions = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    )?.restrictions;
    const blocked = c.req.query("blocked") === "1";
    const outcomeRaw = c.req.query("outcome");
    let outcome: LifecycleOutcome[] | undefined;
    if (outcomeRaw !== undefined) {
      const parsed = z
        .array(LifecycleOutcomeSchema)
        .min(1)
        .safeParse(outcomeRaw.split(","));
      if (!parsed.success)
        return jsonError(
          c,
          400,
          "validation-error",
          "outcome must be a comma list of lifecycle outcomes",
        );
      outcome = parsed.data;
    }

    const { entities, total, next_cursor, outcome_types } = entityOps.list(
      db,
      {
        restrictions,
        type,
        archived,
        ...(Object.keys(dataFilter).length > 0 ? { dataFilter } : {}),
        sort,
        order,
        limit,
        offset,
        cursor,
        ...(tagFilter?.length ? { tagFilter } : {}),
        ...(blocked ? { blocked } : {}),
        ...(outcome ? { outcome } : {}),
      },
      deps.enrichOpts(),
    );

    const paginationMeta = {
      total,
      limit: limit ?? null,
      offset,
      has_more: next_cursor !== null,
      next_cursor,
      scope: {
        restricted: restrictions?.task_types !== undefined,
        // archived=1 lists only archived rows, which neither value describes.
        ...(archived === 0
          ? { archived: "excluded" as const }
          : archived === undefined
            ? { archived: "included" as const }
            : {}),
        ...(outcome_types ? { outcome_types } : {}),
      },
    };

    const compact = c.req.query("compact") === "true";
    if (compact) {
      const activeClaims = coordinationOps.listClaims(db);
      const stats = entityOps.getCompactEntityStats(
        db,
        entities.map((entity) => entity.id),
      );
      const current = currentSchemaOrNull(db);
      return c.json({
        ok: true as const,
        entities: entities.map((e) =>
          entityOps.compactEntity(
            db,
            e,
            activeClaims,
            stats,
            current?.work_units[e.type]?.presentation,
          ),
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
    const origin = originFromBody(body as Record<string, unknown>);
    const entity = entityOps.update(
      db,
      id,
      parsed.data.data,
      parsed.data.fence,
      origin,
      (parsed.data as { tags?: string[] }).tags,
      idempotencyFrom(c),
    );
    return jsonOkRows(c, { entity }, 1);
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
    const origin = originFromBody(body as Record<string, unknown>);
    entityOps.archive(db, id, parsed.data.fence, origin, idempotencyFrom(c));
    return jsonOkRows(c, {}, 1);
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
    c.header("X-Rows-Affected", created ? "1" : "0");
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
    return c.json({
      ok: true,
      relationships: filterRelationships(
        db,
        readCredentialPolicy(c.req.header("X-Tila-Credential-Policy")),
        relationships,
      ),
    });
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
    return jsonOkRows(c, { removed }, removed ? 1 : 0);
  });

  app.get("/summary", (c) =>
    c.json({
      ok: true,
      project: deps.db.transaction((tx) => summaryOps.getSummary(tx)),
    }),
  );

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

    let tagFilter: string[] | undefined;
    try {
      tagFilter = parseTagFilter(c.req.query("tag_filter"));
    } catch (err) {
      if (err instanceof ZodError) {
        return jsonError(
          c,
          400,
          "validation-error",
          err.issues.map((i) => i.message).join("; "),
        );
      }
      throw err;
    }

    try {
      const results = entityOps.searchEntities(db, {
        q,
        entity_type,
        limit,
        tagFilter,
      });
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

    let tagFilter: string[] | undefined;
    try {
      tagFilter = parseTagFilter(c.req.query("tag_filter"));
    } catch (err) {
      if (err instanceof ZodError) {
        return jsonError(
          c,
          400,
          "validation-error",
          err.issues.map((i) => i.message).join("; "),
        );
      }
      throw err;
    }

    const policy = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    );
    const list = (name: string) =>
      c.req
        .query(name)
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    const requestedKinds = list("kind") as SearchKind[] | undefined;
    const types = list("type");
    const syntax = c.req.query("syntax") === "literal" ? "literal" : "fts";

    try {
      const scope = searchPageOps.searchableKinds(policy, requestedKinds);
      const page =
        scope.kinds.length === 0
          ? { results: [], next_cursor: null }
          : searchPageOps.searchPage(db, {
              q,
              syntax,
              kinds: scope.kinds,
              types,
              tagFilter,
              limit,
              cursor: c.req.query("cursor") || undefined,
              restrictions: policy?.restrictions,
            });
      return c.json({
        ok: true,
        results: page.results,
        total: page.results.length,
        next_cursor: page.next_cursor,
        scope: { ...scope, archived: "excluded" as const },
      });
    } catch (err) {
      if (err instanceof artifactOps.SearchQueryError) {
        return jsonError(c, 400, "invalid-query", err.message);
      }
      if (err instanceof searchPageOps.SearchKindDenied) {
        return jsonError(c, 403, "permission-denied", err.message);
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
