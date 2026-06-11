import {
  type RequestOrigin,
  type TemplateInstantiateErrorCode,
  constraintOps,
  schemaOps,
  templateOps,
} from "@tila/ops-sqlite";
import { InstantiateTemplateRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { formatZodIssues, jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

/**
 * HTTP status for each template-instantiate failure code. Preserves EXACTLY the
 * statuses the route returned before the shared `templateOps.instantiateTemplate`
 * extraction: invalid-id/no-schema/constraint-violation → 422, not-found → 404.
 */
const TEMPLATE_ERROR_STATUS: Record<
  TemplateInstantiateErrorCode,
  ContentfulStatusCode
> = {
  "invalid-id": 422,
  "no-schema": 422,
  "not-found": 404,
  "constraint-violation": 422,
};

export function createSchemaRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.get("/schema/current", (c) => {
    const { db } = deps;
    const current = schemaOps.getCurrentSchema(db);
    return c.json({
      ok: true,
      schema: current,
      version: current?.version ?? null,
    });
  });

  app.post("/schema/apply", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      definition: string;
      applied_by: string;
      strategy?: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const schemaOrigin: RequestOrigin = {
      actor: body.applied_by,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    try {
      const result = schemaOps.applySchema(
        db,
        body.definition,
        body.applied_by,
        body.strategy,
        schemaOrigin,
      );
      if (!result.ok && result.reason === "no-change") {
        return c.json({
          ok: true,
          version: null,
          changes: [],
          noChange: true,
        });
      }
      if (!result.ok && result.reason === "destructive") {
        return jsonError(c, 422, "schema-destructive", result.hint, {
          changes: result.changes,
        });
      }
      return c.json({
        ok: true,
        version: result.version,
        changes: result.changes,
      });
    } catch (e) {
      if (e instanceof schemaOps.SchemaParseException) {
        return jsonError(c, 400, "schema-parse-error", e.message);
      }
      throw e;
    }
  });

  app.post("/schema/preview", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as { definition: string };
    try {
      const result = schemaOps.previewSchema(db, body.definition);
      return c.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof schemaOps.SchemaParseException) {
        return jsonError(c, 400, "schema-parse-error", e.message);
      }
      throw e;
    }
  });

  app.get("/template/list", async (c) => {
    const { db } = deps;
    const parsedSchema = constraintOps.resolveCurrentSchema(db);
    if (!parsedSchema?.templates) {
      return c.json({ ok: true, templates: [] });
    }
    const templates = Object.entries(parsedSchema.templates).map(
      ([name, def]) => ({
        name,
        description: def.description ?? null,
        entity_count: Object.keys(def.entities).length,
        entity_types: [
          ...new Set(Object.values(def.entities).map((e) => e.type)),
        ],
      }),
    );
    return c.json({ ok: true, templates });
  });

  app.post("/template/instantiate", async (c) => {
    const { db } = deps;
    const raw = await c.req.json();
    const parsed = InstantiateTemplateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }

    const { template_name, root_id, vars } = parsed.data;

    // Request origin (defaults actor to "system" — unchanged behavior). Passed
    // explicitly to the shared op so the per-caller actor/origin is deliberate.
    const rawRecord = raw as Record<string, unknown>;
    const origin: RequestOrigin = {
      actor: (rawRecord.actor as string | undefined) ?? "system",
      tokenId: (rawRecord.actor_token_id as string | null | undefined) ?? null,
      source: (rawRecord.source as string | null | undefined) ?? null,
      sourceVersion:
        (rawRecord.source_version as string | null | undefined) ?? null,
    };

    try {
      const result = templateOps.instantiateTemplate(db, {
        templateName: template_name,
        rootId: root_id,
        vars,
        origin,
      });
      return c.json({
        ok: true,
        created_entities: result.created_entities,
        created_relationships: result.created_relationships,
        journal_seq: result.journal_seq,
      });
    } catch (e) {
      if (e instanceof templateOps.TemplateInstantiateError) {
        return jsonError(c, TEMPLATE_ERROR_STATUS[e.code], e.code, e.message);
      }
      throw e;
    }
  });

  return app;
}
