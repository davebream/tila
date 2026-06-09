import {
  AddEntityArtifactReferenceRequestSchema,
  ArchiveRequestSchema,
  CreateEntityRelationshipRequestSchema,
  CreateEntityRequestSchema,
  DeleteEntityRelationshipRequestSchema,
  ListEntityRelationshipsRequestSchema,
  TilaSchemaTomlSchema,
  UpdateEntityRequestSchema,
  parseTagFilter,
} from "@tila/schemas";
import { Hono } from "hono";
import TOML from "smol-toml";
import { ZodError } from "zod";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

export const entities = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// POST /projects/:projectId/entities -> DO POST /entity/create
entities.post("/", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  const parsed = CreateEntityRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/entity/create",
    "POST",
    {
      ...parsed.data,
      created_by: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/entities/relationships -> DO POST /entity/relationship/create
// Direction convention: from_id = blocker, to_id = dependent.
// Example: if B depends on A, write from_id=A, to_id=B, type="blocks" (A blocks B).
entities.post("/relationships", requirePermission("write"), async (c) => {
  const raw = await c.req.json();
  const parsed = CreateEntityRelationshipRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/entity/relationship/create",
    "POST",
    {
      ...parsed.data,
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/entities/relationships -> DO GET /entity/relationship/list
// IMPORTANT: must be registered before /:id to avoid wildcard capture.
// Filters (from_id, to_id, type) are passed as query params.
entities.get("/relationships", requirePermission("read"), async (c) => {
  const parsed = ListEntityRelationshipsRequestSchema.safeParse({
    from_id: c.req.query("from_id"),
    to_id: c.req.query("to_id"),
    type: c.req.query("type"),
  });
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const query: Record<string, string> = {};
  if (parsed.data.from_id) query.from_id = parsed.data.from_id;
  if (parsed.data.to_id) query.to_id = parsed.data.to_id;
  if (parsed.data.type) query.type = parsed.data.type;
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/entity/relationship/list",
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});

// DELETE /projects/:projectId/entities/relationships -> DO POST /entity/relationship/delete
// The composite key (from_id, to_id, type) is passed as query params because the
// SDK client's DELETE has no request body. Success returns 200 with { ok, removed }.
entities.delete("/relationships", requirePermission("write"), async (c) => {
  const parsed = DeleteEntityRelationshipRequestSchema.safeParse({
    from_id: c.req.query("from_id"),
    to_id: c.req.query("to_id"),
    type: c.req.query("type"),
  });
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    "/entity/relationship/delete",
    "POST",
    {
      ...parsed.data,
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/entities/ready -> DO GET /entity/ready
// IMPORTANT: must be registered before /:id to avoid wildcard capture
entities.get("/ready", async (c) => {
  const stub = c.get("doStub");
  const query: Record<string, string> = {};
  const type = c.req.query("type");
  if (type) query.type = type;
  const parent = c.req.query("parent");
  if (parent) query.parent = parent;
  const limit = c.req.query("limit");
  if (limit) query.limit = limit;
  const includeSoftBlocked = c.req.query("include-soft-blocked");
  if (includeSoftBlocked) query["include-soft-blocked"] = includeSoftBlocked;
  return forwardToDO(
    stub,
    "/entity/ready",
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/entities/:id -> DO GET /entity/get/:id
entities.get("/:id", async (c) => {
  const id = c.req.param("id");
  const stub = c.get("doStub");
  const query: Record<string, string> = {};
  const compact = c.req.query("compact");
  if (compact) query.compact = compact;
  const fields = c.req.query("fields");
  if (fields) query.fields = fields;
  return forwardToDO(
    stub,
    `/entity/get/${id}`,
    "GET",
    undefined,
    Object.keys(query).length > 0 ? query : undefined,
    analyticsCtxFrom(c),
  );
});

// GET /projects/:projectId/entities -> DO GET /entity/list
entities.get("/", async (c) => {
  const stub = c.get("doStub");
  const query: Record<string, string> = {};
  const type = c.req.query("type");
  if (type) query.type = type;
  const archived = c.req.query("archived");
  if (archived) query.archived = archived;
  const status = c.req.query("status");
  if (status) query.status = status;
  const parent = c.req.query("parent");
  if (parent) query.parent = parent;
  const compact = c.req.query("compact");
  if (compact) query.compact = compact;
  const fields = c.req.query("fields");
  if (fields) query.fields = fields;
  // Pagination and sorting params
  const sort = c.req.query("sort");
  if (sort) query.sort = sort;
  const order = c.req.query("order");
  if (order) query.order = order;
  const limit = c.req.query("limit");
  if (limit) query.limit = limit;
  const offset = c.req.query("offset");
  if (offset) query.offset = offset;
  let tagFilter: string[] | undefined;
  try {
    tagFilter = parseTagFilter(c.req.query("tag_filter"));
  } catch (err) {
    if (err instanceof ZodError) return zodValidationError(c, err);
    throw err;
  }
  if (tagFilter?.length) query.tag_filter = tagFilter.join(",");
  return forwardToDO(
    stub,
    "/entity/list",
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});

// PATCH /projects/:projectId/entities/:id -> DO POST /entity/update/:id
entities.patch("/:id", requirePermission("write"), async (c) => {
  const id = c.req.param("id");
  const raw = await c.req.json();
  const parsed = UpdateEntityRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  return forwardToDO(
    stub,
    `/entity/update/${id}`,
    "POST",
    {
      ...parsed.data,
      actor: tokenResult.name,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/entities/:id/archive -> DO POST /entity/archive/:id
entities.post("/:id/archive", requirePermission("write"), async (c) => {
  const id = c.req.param("id");
  const tokenResult = c.get("tokenResult");
  const stub = c.get("doStub");

  const raw = await c.req.json().catch(() => ({}));
  const parsed = ArchiveRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  return forwardToDO(
    stub,
    `/entity/archive/${id}`,
    "POST",
    {
      actor: tokenResult.name,
      fence: parsed.data.fence,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtxFrom(c),
  );
});

// POST /projects/:projectId/entities/:entityId/artifact-refs -> DO POST /entity/artifact-ref
// Validates slot against tila.schema.toml if entity_artifact_references.slots is declared
entities.post(
  "/:entityId/artifact-refs",
  requirePermission("write"),
  async (c) => {
    const entityId = c.req.param("entityId");
    const raw = await c.req.json();
    const parsed = AddEntityArtifactReferenceRequestSchema.safeParse(raw);
    if (!parsed.success) return zodValidationError(c, parsed.error);

    // TOML slot validation: fetch current schema and validate slot if declared
    const stub = c.get("doStub");
    const schemaRes = await forwardToDO(
      stub,
      "/schema/current",
      "GET",
      undefined,
      undefined,
      analyticsCtxFrom(c),
    );
    const schemaBody = (await schemaRes.json()) as {
      ok: boolean;
      schema: { definition: string } | null;
    };

    if (schemaBody.ok && schemaBody.schema?.definition) {
      try {
        const tomlParsed = TOML.parse(schemaBody.schema.definition);
        const schemaDef = TilaSchemaTomlSchema.safeParse(tomlParsed);
        if (schemaDef.success) {
          const declaredSlots =
            schemaDef.data.entity_artifact_references?.slots;
          if (declaredSlots && declaredSlots.length > 0) {
            if (!declaredSlots.includes(parsed.data.slot)) {
              return c.json(
                {
                  ok: false,
                  error: {
                    code: "invalid-slot",
                    message: `Slot "${parsed.data.slot}" is not declared in tila.schema.toml. Valid slots: ${declaredSlots.join(", ")}`,
                    retryable: false,
                  },
                },
                422,
              );
            }
          }
        }
      } catch {
        // TOML parse failure: log warning and allow through (permissive default)
        console.warn("Failed to parse tila.schema.toml for slot validation");
      }
    }
    // No schema or no slots declared: allow any slot (permissive default)

    const tokenResult = c.get("tokenResult");
    return forwardToDO(
      stub,
      "/entity/artifact-ref",
      "POST",
      {
        entity_id: entityId,
        artifact_key: parsed.data.artifact_key,
        slot: parsed.data.slot,
        metadata: parsed.data.metadata,
        actor: tokenResult.name,
        actor_token_id: tokenResult.tokenId,
        source: c.get("source"),
        source_version: c.get("sourceVersion"),
      },
      undefined,
      analyticsCtxFrom(c),
    );
  },
);

// GET /projects/:projectId/entities/:entityId/artifact-refs -> DO GET /entity/artifact-refs
entities.get("/:entityId/artifact-refs", async (c) => {
  const entityId = c.req.param("entityId");
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    "/entity/artifact-refs",
    "GET",
    undefined,
    {
      entity_id: entityId,
    },
    analyticsCtxFrom(c),
  );
});
