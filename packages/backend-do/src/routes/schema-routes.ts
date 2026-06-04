import {
  type RequestOrigin,
  constraintOps,
  journalOps,
  schema,
  schemaOps,
} from "@tila/ops-sqlite";
import { InstantiateTemplateRequestSchema } from "@tila/schemas";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { formatZodIssues, jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

const { checkEntityTypeDeclared, resolveCurrentSchema } = constraintOps;

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
    const parsedSchema = resolveCurrentSchema(db);
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

    if (root_id.includes("/")) {
      return jsonError(
        c,
        422,
        "invalid-id",
        `root_id "${root_id}" contains '/' which is not allowed in entity IDs`,
      );
    }

    const parsedSchema = resolveCurrentSchema(db);
    if (!parsedSchema) {
      return jsonError(
        c,
        422,
        "no-schema",
        "No schema applied to this project",
      );
    }

    const templateDef = parsedSchema.templates?.[template_name];
    if (!templateDef) {
      return jsonError(
        c,
        404,
        "not-found",
        `Template "${template_name}" not found in schema`,
      );
    }

    for (const [entityKey, entity] of Object.entries(templateDef.entities)) {
      const typeCheck = checkEntityTypeDeclared(parsedSchema, entity.type);
      if (!typeCheck.ok) {
        return jsonError(
          c,
          422,
          typeCheck.code,
          `Template entity "${entityKey}": ${typeCheck.message}`,
        );
      }
    }

    for (const [entityKey, entity] of Object.entries(templateDef.entities)) {
      const entityId = root_id + entity.id_suffix;
      if (entityId.includes("/")) {
        return jsonError(
          c,
          422,
          "invalid-id",
          `Computed entity ID "${entityId}" (from entity "${entityKey}") contains '/'`,
        );
      }
    }

    const schemaVersion = schemaOps.getCurrentSchema(db)?.version ?? 1;
    const actor =
      ((raw as Record<string, unknown>).actor as string | undefined) ??
      "system";
    const templateOrigin: RequestOrigin = {
      actor,
      tokenId:
        ((raw as Record<string, unknown>).actor_token_id as
          | string
          | null
          | undefined) ?? null,
      source:
        ((raw as Record<string, unknown>).source as
          | string
          | null
          | undefined) ?? null,
      sourceVersion:
        ((raw as Record<string, unknown>).source_version as
          | string
          | null
          | undefined) ?? null,
    };
    const now = Date.now();

    function applyVar(value: unknown, v: Record<string, string>): unknown {
      if (typeof value !== "string") return value;
      return value.replace(
        /\{\{(\w+)\}\}/g,
        (_, k: string) => v[k] ?? `{{${k}}}`,
      );
    }

    function applyVarsToData(
      data: Record<string, unknown>,
      v: Record<string, string>,
    ): Record<string, unknown> {
      return Object.fromEntries(
        Object.entries(data).map(([k, val]) => [k, applyVar(val, v)]),
      );
    }

    const { createdEntityIds, relationshipCount, journalSeq } = db.transaction(
      (tx) => {
        const entityIds: string[] = [];
        let relCount = 0;

        for (const [, entity] of Object.entries(templateDef.entities)) {
          const entityId = root_id + entity.id_suffix;
          const data = applyVarsToData(
            entity.data as Record<string, unknown>,
            vars,
          );
          tx.insert(schema.entities)
            .values({
              id: entityId,
              type: entity.type,
              schema_version: schemaVersion,
              data: JSON.stringify(data),
              archived: 0,
              created_at: now,
              updated_at: now,
              created_by: actor,
            })
            .run();
          entityIds.push(entityId);
        }

        for (const rel of templateDef.relationships) {
          const fromEntity = templateDef.entities[rel.from];
          const toEntity = templateDef.entities[rel.to];
          if (!fromEntity || !toEntity) continue;
          const fromId = root_id + fromEntity.id_suffix;
          const toId = root_id + toEntity.id_suffix;
          tx.run(
            sql`INSERT INTO entity_relationships (from_id, to_id, type, schema_version, created_at) VALUES (${fromId}, ${toId}, ${rel.type}, ${schemaVersion}, ${now})`,
          );
          relCount++;
        }

        journalOps.appendJournal(tx, {
          kind: "template.instantiated",
          resource: root_id,
          actor: templateOrigin.actor,
          tokenId: templateOrigin.tokenId,
          source: templateOrigin.source,
          sourceVersion: templateOrigin.sourceVersion,
          data: {
            template_name,
            created_entity_ids: entityIds,
            vars_used: Object.keys(vars),
          },
        });

        const seqRow = tx
          .select({ seq: schema.journal.seq })
          .from(schema.journal)
          .orderBy(sql`seq DESC`)
          .limit(1)
          .get();
        const journalSeq = seqRow?.seq ?? 0;

        return {
          createdEntityIds: entityIds,
          relationshipCount: relCount,
          journalSeq,
        };
      },
    );

    return c.json({
      ok: true,
      created_entities: createdEntityIds,
      created_relationships: relationshipCount,
      journal_seq: journalSeq,
    });
  });

  return app;
}
