import { applyRecordLegacyDefaults } from "@tila/core";
import {
  type RequestOrigin,
  artifactOps,
  constraintOps,
  recordOps,
  schemaOps,
  validateRecordValue,
} from "@tila/ops-sqlite";
import {
  RecordArchiveRequestSchema,
  RecordCreateRequestSchema,
  RecordPatchRequestSchema,
  RecordPutRequestSchema,
  RecordSetRequestSchema,
  RecordUnarchiveRequestSchema,
  RecordValueSchema,
  formatRecordResource,
  parseTagFilter,
} from "@tila/schemas";
import { Hono } from "hono";
import { ZodError } from "zod";
import { idempotencyFrom, jsonError, jsonOkRows } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

const { checkRecordTypeDeclared, resolveCurrentSchema } = constraintOps;

function serializeRecord(result: recordOps.RecordRow) {
  return {
    type: result.type,
    key: result.key,
    schema_version: result.schema_version,
    value: result.value,
    value_sha256: result.value_sha256,
    revision: result.revision,
    archived: result.archived,
    created_at: result.created_at,
    updated_at: result.updated_at,
    updated_by: result.updated_by,
    tags: result.tags,
  };
}

function upsertCanonicalSnapshot(
  deps: RouterDeps,
  type: string,
  key: string,
  canonicalArtifactKey: string,
  valueSha256: string,
  actor: string,
): void {
  const resource = formatRecordResource(type, key);
  artifactOps.upsertPointer(
    deps.db,
    {
      r2_key: canonicalArtifactKey,
      resource,
      kind: "record-snapshot-canonical",
      sha256: valueSha256,
      bytes: 0,
      fence: null,
      mime_type: "application/json",
      produced_at: Date.now(),
      produced_by: actor,
      expires_at: null,
    },
    { actor },
    "artifact.produced",
  );
}

type ValidateRecordWriteResult =
  | { ok: true; schemaVersion: number }
  | { ok: false; status: 422; code: "constraint-violation"; message: string };

/**
 * Shared record-write validation for the create/set/put handlers.
 *
 * Resolves the record's `schema_version` from the current schema and, when a
 * schema is declared, gates on record-type-declared + record-value validation
 * exactly as the create/set handlers did inline. Returns the resolved
 * `schema_version` on success, or a structured rejection the caller maps to a
 * `jsonError` 422. Keeping this DRY across create/set/put avoids a third copy of
 * the validation block (DO rule).
 */
function validateRecordWrite(
  deps: RouterDeps,
  type: string,
  value: Record<string, unknown>,
): ValidateRecordWriteResult {
  const currentSchema = resolveCurrentSchema(deps.db);
  const schemaVersion = currentSchema
    ? (schemaOps.getCurrentSchema(deps.db)?.version ?? 0)
    : 0;

  if (currentSchema) {
    const typeCheck = checkRecordTypeDeclared(currentSchema, type);
    if (!typeCheck.ok) {
      return {
        ok: false,
        status: 422,
        code: "constraint-violation",
        message: typeCheck.message,
      };
    }

    const recordDef = currentSchema.records?.[type];
    if (recordDef) {
      const valResult = validateRecordValue(value, recordDef);
      if (!valResult.ok) {
        return {
          ok: false,
          status: 422,
          code: "constraint-violation",
          message: valResult.errors.join("; "),
        };
      }
    }
  }

  return { ok: true, schemaVersion };
}

export function createRecordRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/record/:type/create", async (c) => {
    const { type } = c.req.param();
    const rawBody = (await c.req.json()) as Record<string, unknown>;
    const body = RecordCreateRequestSchema.parse(rawBody);
    // Provenance: the Worker forwards the caller identity in the body; read it
    // body-first (mirror put/stamp) so HTTP-written records are attributed to
    // the real actor instead of "anonymous".
    const actor =
      (rawBody.actor as string | undefined) ??
      c.req.header("x-actor") ??
      "anonymous";
    const provenance: RequestOrigin = {
      actor,
      tokenId: (rawBody.actor_token_id as string | null | undefined) ?? null,
      source: (rawBody.source as string | null | undefined) ?? null,
      sourceVersion:
        (rawBody.source_version as string | null | undefined) ?? null,
    };

    const validation = validateRecordWrite(deps, type, body.value);
    if (!validation.ok) {
      return jsonError(
        c,
        validation.status,
        validation.code,
        validation.message,
      );
    }
    const schemaVersion = validation.schemaVersion;

    const canonicalArtifactKey =
      ((rawBody as Record<string, unknown>).canonical_artifact_key as
        | string
        | null
        | undefined) ?? null;
    const result = await recordOps.createRecord(
      deps.db,
      {
        type,
        key: body.key,
        value: body.value,
        tags: body.tags,
        message: body.message,
        source_artifact_key: body.source_artifact_key,
        canonical_artifact_key: canonicalArtifactKey,
        schema_version: schemaVersion,
        actor,
      },
      provenance,
    );

    if (canonicalArtifactKey !== null) {
      upsertCanonicalSnapshot(
        deps,
        type,
        body.key,
        canonicalArtifactKey,
        result.value_sha256,
        actor,
      );
    }

    c.header("X-Rows-Affected", "1");
    return c.json(
      {
        ok: true,
        record: serializeRecord(result),
        fence: result.fence,
        revision: result.revision,
      },
      201,
    );
  });

  app.post("/record/:type/:key{.+}/set", async (c) => {
    const { type, key } = c.req.param();
    const rawSetBody = (await c.req.json()) as Record<string, unknown>;
    const body = RecordSetRequestSchema.parse(rawSetBody);
    const actor =
      (rawSetBody.actor as string | undefined) ??
      c.req.header("x-actor") ??
      "anonymous";
    const setProvenance: RequestOrigin = {
      actor,
      tokenId: (rawSetBody.actor_token_id as string | null | undefined) ?? null,
      source: (rawSetBody.source as string | null | undefined) ?? null,
      sourceVersion:
        (rawSetBody.source_version as string | null | undefined) ?? null,
    };

    const validation = validateRecordWrite(deps, type, body.value);
    if (!validation.ok) {
      return jsonError(
        c,
        validation.status,
        validation.code,
        validation.message,
      );
    }
    const schemaVersion = validation.schemaVersion;

    const canonicalArtifactKey =
      ((rawSetBody as Record<string, unknown>).canonical_artifact_key as
        | string
        | null
        | undefined) ?? null;
    const result = await recordOps.setRecord(
      deps.db,
      {
        type,
        key,
        value: body.value,
        fence: body.fence,
        tags: body.tags,
        message: body.message,
        source_artifact_key: body.source_artifact_key,
        canonical_artifact_key: canonicalArtifactKey,
        schema_version: schemaVersion,
        actor,
      },
      setProvenance,
      idempotencyFrom(c),
    );

    if (canonicalArtifactKey !== null) {
      upsertCanonicalSnapshot(
        deps,
        type,
        key,
        canonicalArtifactKey,
        result.value_sha256,
        actor,
      );
    }

    return jsonOkRows(
      c,
      {
        record: serializeRecord(result),
        fence: result.fence,
        revision: result.revision,
      },
      1,
    );
  });

  // Fenceless create-or-replace (upsert). Registered before the generic
  // `:key{.+}` catch-alls. HTTP 200 on both create and replace branches.
  app.post("/record/:type/:key{.+}/put", async (c) => {
    const { type, key } = c.req.param();
    const rawPutBody = (await c.req.json()) as Record<string, unknown>;
    const body = RecordPutRequestSchema.parse(rawPutBody);

    // 64 KiB boundary guard — fires before the write.
    const sizeCheck = RecordValueSchema.safeParse(body.value);
    if (!sizeCheck.success) {
      return jsonError(
        c,
        413,
        "payload-too-large",
        "Value exceeds 64 KiB canonical JSON limit",
      );
    }

    // Provenance: read actor from the body (worker forwards it), falling back
    // to the x-actor header then "anonymous" (mirror the stamp handler).
    const actor =
      (rawPutBody.actor as string | undefined) ??
      c.req.header("x-actor") ??
      "anonymous";
    const putProvenance: RequestOrigin = {
      actor,
      tokenId: (rawPutBody.actor_token_id as string | null | undefined) ?? null,
      source: (rawPutBody.source as string | null | undefined) ?? null,
      sourceVersion:
        (rawPutBody.source_version as string | null | undefined) ?? null,
    };

    const validation = validateRecordWrite(deps, type, body.value);
    if (!validation.ok) {
      return jsonError(
        c,
        validation.status,
        validation.code,
        validation.message,
      );
    }

    const canonicalArtifactKey =
      (rawPutBody.canonical_artifact_key as string | null | undefined) ?? null;
    const result = await recordOps.putRecord(
      deps.db,
      {
        type,
        key,
        value: body.value,
        tags: body.tags,
        message: body.message,
        source_artifact_key: body.source_artifact_key,
        canonical_artifact_key: canonicalArtifactKey,
        schema_version: validation.schemaVersion,
        actor,
      },
      putProvenance,
    );

    if (canonicalArtifactKey !== null) {
      upsertCanonicalSnapshot(
        deps,
        type,
        key,
        canonicalArtifactKey,
        result.value_sha256,
        actor,
      );
    }

    return jsonOkRows(
      c,
      {
        record: serializeRecord(result),
        fence: result.fence,
        revision: result.revision,
      },
      1,
    );
  });

  app.post("/record/:type/:key{.+}/patch", async (c) => {
    const { type, key } = c.req.param();
    const rawPatchBody = (await c.req.json()) as Record<string, unknown>;
    const body = RecordPatchRequestSchema.parse(rawPatchBody);
    const actor =
      (rawPatchBody.actor as string | undefined) ??
      c.req.header("x-actor") ??
      "anonymous";
    const patchProvenance: RequestOrigin = {
      actor,
      tokenId:
        (rawPatchBody.actor_token_id as string | null | undefined) ?? null,
      source: (rawPatchBody.source as string | null | undefined) ?? null,
      sourceVersion:
        (rawPatchBody.source_version as string | null | undefined) ?? null,
    };

    const currentSchema = resolveCurrentSchema(deps.db);
    const schemaVersion = currentSchema
      ? (schemaOps.getCurrentSchema(deps.db)?.version ?? 0)
      : 0;

    if (currentSchema) {
      const typeCheck = checkRecordTypeDeclared(currentSchema, type);
      if (!typeCheck.ok) {
        return jsonError(c, 422, "constraint-violation", typeCheck.message);
      }
    }

    const result = await recordOps.patchRecord(
      deps.db,
      {
        type,
        key,
        patch: body.patch as Record<string, unknown>,
        fence: body.fence,
        message: body.message,
        schema_version: schemaVersion,
        actor,
      },
      patchProvenance,
      idempotencyFrom(c),
    );

    return jsonOkRows(
      c,
      {
        record: serializeRecord(result),
        fence: result.fence,
        revision: result.revision,
      },
      1,
    );
  });

  app.post("/record/:type/:key{.+}/archive", async (c) => {
    const { type, key } = c.req.param();
    const rawArchiveBody = (await c.req.json()) as Record<string, unknown>;
    const body = RecordArchiveRequestSchema.parse(rawArchiveBody);
    const actor =
      (rawArchiveBody.actor as string | undefined) ??
      c.req.header("x-actor") ??
      "anonymous";
    const archiveProvenance: RequestOrigin = {
      actor,
      tokenId:
        (rawArchiveBody.actor_token_id as string | null | undefined) ?? null,
      source: (rawArchiveBody.source as string | null | undefined) ?? null,
      sourceVersion:
        (rawArchiveBody.source_version as string | null | undefined) ?? null,
    };

    const currentSchema = resolveCurrentSchema(deps.db);
    const schemaVersion = currentSchema
      ? (schemaOps.getCurrentSchema(deps.db)?.version ?? 0)
      : 0;

    if (currentSchema) {
      const typeCheck = checkRecordTypeDeclared(currentSchema, type);
      if (!typeCheck.ok) {
        return jsonError(c, 422, "constraint-violation", typeCheck.message);
      }
    }

    const result = recordOps.archiveRecord(
      deps.db,
      {
        type,
        key,
        fence: body.fence,
        message: body.message,
        schema_version: schemaVersion,
        actor,
      },
      archiveProvenance,
      idempotencyFrom(c),
    );

    return jsonOkRows(
      c,
      {
        record: serializeRecord(result),
        fence: result.fence,
        revision: result.revision,
      },
      1,
    );
  });

  app.post("/record/:type/:key{.+}/unarchive", async (c) => {
    const { type, key } = c.req.param();
    const rawUnarchiveBody = (await c.req.json()) as Record<string, unknown>;
    const body = RecordUnarchiveRequestSchema.parse(rawUnarchiveBody);
    const actor =
      (rawUnarchiveBody.actor as string | undefined) ??
      c.req.header("x-actor") ??
      "anonymous";
    const unarchiveProvenance: RequestOrigin = {
      actor,
      tokenId:
        (rawUnarchiveBody.actor_token_id as string | null | undefined) ?? null,
      source: (rawUnarchiveBody.source as string | null | undefined) ?? null,
      sourceVersion:
        (rawUnarchiveBody.source_version as string | null | undefined) ?? null,
    };

    const currentSchema = resolveCurrentSchema(deps.db);
    const schemaVersion = currentSchema
      ? (schemaOps.getCurrentSchema(deps.db)?.version ?? 0)
      : 0;

    if (currentSchema) {
      const typeCheck = checkRecordTypeDeclared(currentSchema, type);
      if (!typeCheck.ok) {
        return jsonError(c, 422, "constraint-violation", typeCheck.message);
      }
    }

    const result = recordOps.unarchiveRecord(
      deps.db,
      {
        type,
        key,
        fence: body.fence,
        message: body.message,
        schema_version: schemaVersion,
        actor,
      },
      unarchiveProvenance,
      idempotencyFrom(c),
    );

    return jsonOkRows(
      c,
      {
        record: serializeRecord(result),
        fence: result.fence,
        revision: result.revision,
      },
      1,
    );
  });

  app.post("/record/:type/:key{.+}/stamp-artifacts", async (c) => {
    const { type, key } = c.req.param();
    const body = (await c.req.json()) as {
      revision: number;
      canonical_artifact_key: string;
      source_artifact_key: string | null;
      sha256: string;
      bytes: number;
      actor: string;
    };

    if (
      typeof body.revision !== "number" ||
      !body.canonical_artifact_key ||
      !body.sha256
    ) {
      return jsonError(
        c,
        400,
        "validation-error",
        "revision, canonical_artifact_key, and sha256 are required",
      );
    }

    const actor = body.actor ?? c.req.header("x-actor") ?? "anonymous";

    recordOps.stampArtifacts(deps.db, {
      type,
      key,
      revision: body.revision,
      canonical_artifact_key: body.canonical_artifact_key,
      source_artifact_key: body.source_artifact_key ?? null,
    });

    const resource = formatRecordResource(type, key);
    artifactOps.upsertPointer(
      deps.db,
      {
        r2_key: body.canonical_artifact_key,
        resource,
        kind: "record-snapshot-canonical",
        sha256: body.sha256,
        bytes: body.bytes ?? 0,
        fence: null,
        mime_type: "application/json",
        produced_at: Date.now(),
        produced_by: actor,
        expires_at: null,
      },
      { actor },
      "artifact.produced",
    );

    return c.json({ ok: true });
  });

  app.get("/record/types-in-use", (c) => {
    const types = recordOps.listRecordTypesInUse(deps.db);
    return c.json({ ok: true, types });
  });

  app.get("/record/:type/list", (c) => {
    const { type } = c.req.param();
    const tag = c.req.query("tag");
    const includeArchived = c.req.query("includeArchived") === "true";
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const dataFilterParam = c.req.query("dataFilter");

    let dataFilter: Record<string, unknown> | undefined;
    if (dataFilterParam) {
      try {
        dataFilter = JSON.parse(dataFilterParam) as Record<string, unknown>;
      } catch {
        return jsonError(
          c,
          400,
          "validation-error",
          "dataFilter must be valid JSON",
        );
      }
    }

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
      const result = recordOps.listRecords(deps.db, {
        type,
        includeArchived,
        tag: tag ?? undefined,
        dataFilter,
        limit,
        tagFilter,
      });

      return c.json({
        ok: true,
        items: result.items,
        meta: {
          total: result.total,
          limit: limit ?? 200,
          next_cursor: result.next_cursor,
        },
      });
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("dataFilter values must be scalar")
      ) {
        return jsonError(c, 400, "validation-error", err.message);
      }
      throw err;
    }
  });

  app.get("/record/:type/:key{.+}/history", (c) => {
    const { type, key } = c.req.param();
    const includeValues = c.req.query("values") === "true";
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

    const result = recordOps.listRecordHistory(deps.db, type, key, {
      limit,
      includeValues,
    });

    return c.json({
      ok: true,
      items: result.items,
      meta: {
        total: result.total,
        limit: limit ?? 20,
        next_cursor: result.next_cursor,
      },
    });
  });

  app.get("/record/:type/:key{.+}", (c) => {
    const { type, key } = c.req.param();
    const result = recordOps.getRecord(deps.db, type, key);

    if (!result) {
      return jsonError(c, 404, "not-found", `Record ${type}/${key} not found`);
    }

    // Apply legacy default enrichment using the current schema.
    // Uses current schema (not the schema version the record was written against)
    // because new fields with default_for_legacy only exist in the latest schema.
    const currentSchema = resolveCurrentSchema(deps.db);
    const enrichedValue = currentSchema
      ? applyRecordLegacyDefaults(result.value, currentSchema, result.type)
      : result.value;

    return c.json({
      ok: true,
      record: serializeRecord({ ...result, value: enrichedValue }),
      fence: result.fence,
    });
  });

  return app;
}
