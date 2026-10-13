import {
  CredentialPolicyDenied,
  assertResourceAccess,
  filterRelationships,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
import {
  type RequestOrigin,
  type TemplateInstantiateErrorCode,
  constraintOps,
  schemaOps,
  templateOps,
} from "@tila/ops-sqlite";
import {
  InstantiateTemplateRequestSchema,
  SchemaApplyRequestSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { originFromBody } from "./origin";
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
      revision: current?.version ?? 0,
    });
  });

  app.post("/schema/apply", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      definition: string;
      applied_by: string;
      strategy?: string;
      expected_revision?: number;
      reviewed_definition?: string;
      idempotency_key?: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const schemaOrigin = originFromBody(body as Record<string, unknown>);
    try {
      // The Worker may use a caller-scoped key longer than the public key limit.
      const parsed = SchemaApplyRequestSchema.safeParse({
        ...body,
        idempotency_key: undefined,
      });
      if (!parsed.success)
        return jsonError(c, 400, "validation-error", parsed.error.message);
      const result = schemaOps.applySchema(
        db,
        body.definition,
        body.applied_by,
        body.strategy,
        schemaOrigin,
        body,
      );
      if (!result.ok && result.reason === "no-change") {
        return c.json({
          ok: true,
          version: null,
          changes: [],
          noChange: true,
          revision: result.revision,
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
        revision: result.revision,
      });
    } catch (e) {
      if (e instanceof schemaOps.SchemaParseException) {
        return jsonError(c, 400, "schema-parse-error", e.message, {
          errors: e.errors,
        });
      }
      throw e;
    }
  });

  app.get("/schema/history", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const before =
      c.req.query("before") === undefined
        ? undefined
        : Number(c.req.query("before"));
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 250 ||
      (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
    ) {
      return jsonError(
        c,
        400,
        "validation-error",
        "limit must be 1–250 and before a positive revision",
      );
    }
    return c.json({
      ok: true,
      entries: schemaOps.listSchemaHistory(deps.db, limit, before),
    });
  });

  app.post("/schema/preview", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as { definition: string };
    try {
      const result = schemaOps.previewSchema(db, body.definition);
      return c.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof schemaOps.SchemaParseException) {
        return jsonError(c, 400, "schema-parse-error", e.message, {
          errors: e.errors,
        });
      }
      throw e;
    }
  });

  app.get("/template/list", async (c) => {
    const templates = templateOps.listTemplates(
      constraintOps.resolveCurrentSchema(deps.db),
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
    const origin = originFromBody(rawRecord);

    try {
      const result = templateOps.instantiateTemplate(db, {
        policy: readCredentialPolicy(c.req.header("X-Tila-Credential-Policy")),
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
