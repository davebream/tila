import { applyRecordLegacyDefaults } from "@tila/core";
import {
  CredentialPolicyDenied,
  assertResourceAccess,
  filterRelationships,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
import {
  constraintOps,
  recordOps,
  schemaOps,
  validateRecordValue,
} from "@tila/ops-sqlite";
import {
  RECORD_LIST_SORTS,
  RecordArchiveRequestSchema,
  RecordCreateRequestSchema,
  RecordGetQuerySchema,
  RecordPatchRequestSchema,
  RecordPutRequestSchema,
  RecordSetRequestSchema,
  RecordUnarchiveRequestSchema,
  RecordValueSchema,
  canEchoStoredRecord,
  hasRecordRestrictions,
  okEnvelope,
  parseTagFilter,
} from "@tila/schemas";
import { type Context, Hono } from "hono";
import { ZodError } from "zod";
import { originFromBody } from "./origin";
import { idempotencyFrom, jsonError, jsonOkRows } from "./responses";
import {
  type ProjectSubRouter,
  type RouterDeps,
  WITHHOLD_RECORD_DETAIL_KEY,
} from "./types";

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

/**
 * Response for `create`, `set` and `put`. A split policy that may write but
 * not read the key gets a receipt: the replace branch reads the stored row
 * back, and every field of the result row is stored or derived server-side
 * (including the actor and the schema version), so none of it is returned.
 * The receipt repeats the record the caller addressed and the fence a later
 * fenced write needs. Every other caller keeps the full record.
 */
function serializeWriteResponse(
  c: Context,
  target: { type: string; key: string },
  result: recordOps.RecordRow,
) {
  const policy = readCredentialPolicy(c.req.header("X-Tila-Credential-Policy"));
  if (
    policy === undefined ||
    canEchoStoredRecord(policy, target.type, target.key)
  )
    return {
      record: serializeRecord(result),
      fence: result.fence,
      revision: result.revision,
    };
  return {
    receipt: true,
    type: target.type,
    key: target.key,
    fence: result.fence,
  };
}

function withholdsDetail(c: Context): boolean {
  return (
    (c.get as (k: string) => boolean | undefined)(
      WITHHOLD_RECORD_DETAIL_KEY,
    ) === true
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
  withholdDetail: boolean,
): ValidateRecordWriteResult {
  const currentSchema = resolveCurrentSchema(deps.db);
  const schemaVersion = currentSchema
    ? (schemaOps.getCurrentSchema(deps.db)?.version ?? 0)
    : 0;

  if (currentSchema) {
    const typeCheck = checkRecordTypeDeclared(currentSchema, type, {
      listDeclared: !withholdDetail,
    });
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
    const provenance = originFromBody(rawBody);

    const validation = validateRecordWrite(
      deps,
      type,
      body.value,
      withholdsDetail(c),
    );
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

    c.header("X-Rows-Affected", "1");
    return c.json(
      okEnvelope(serializeWriteResponse(c, { type, key: body.key }, result)),
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
    const setProvenance = originFromBody(rawSetBody);

    const validation = validateRecordWrite(
      deps,
      type,
      body.value,
      withholdsDetail(c),
    );
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

    return jsonOkRows(c, serializeWriteResponse(c, { type, key }, result), 1);
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
    const putProvenance = originFromBody(rawPutBody);

    const validation = validateRecordWrite(
      deps,
      type,
      body.value,
      withholdsDetail(c),
    );
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

    return jsonOkRows(c, serializeWriteResponse(c, { type, key }, result), 1);
  });

  app.post("/record/:type/:key{.+}/patch", async (c) => {
    const { type, key } = c.req.param();
    const rawPatchBody = (await c.req.json()) as Record<string, unknown>;
    const body = RecordPatchRequestSchema.parse(rawPatchBody);
    const actor =
      (rawPatchBody.actor as string | undefined) ??
      c.req.header("x-actor") ??
      "anonymous";
    const patchProvenance = originFromBody(rawPatchBody);

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
    const archiveProvenance = originFromBody(rawArchiveBody);

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
    const unarchiveProvenance = originFromBody(rawUnarchiveBody);

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

    const stampOrigin = originFromBody(body as Record<string, unknown>);

    recordOps.stampArtifacts(
      deps.db,
      {
        type,
        key,
        revision: body.revision,
        canonical_artifact_key: body.canonical_artifact_key,
        source_artifact_key: body.source_artifact_key ?? null,
      },
      stampOrigin,
    );

    return c.json({ ok: true });
  });

  app.get("/record/types-in-use", (c) => {
    const restrictions = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    )?.restrictions;
    const types = recordOps.listRecordTypesInUse(deps.db, restrictions);
    const counts = recordOps.countRecordTypes(deps.db, restrictions);
    return c.json({ ok: true, types, counts });
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

    const restrictions = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    )?.restrictions;
    const sortParam = c.req.query("sort");
    const sort = (RECORD_LIST_SORTS as readonly string[]).includes(
      sortParam ?? "",
    )
      ? (sortParam as recordOps.RecordListSort)
      : undefined;
    let titleField: string | undefined;
    try {
      titleField = constraintOps.resolveCurrentSchema(deps.db)?.records?.[type]
        ?.presentation?.title;
    } catch {
      // A corrupt schema only loses presented titles on this list.
    }

    try {
      const result = recordOps.listRecords(deps.db, {
        restrictions,
        type,
        includeArchived,
        tag: tag ?? undefined,
        dataFilter,
        limit,
        tagFilter,
        sort,
        order: c.req.query("order") === "desc" ? "desc" : "asc",
        keyContains: c.req.query("keyContains") || undefined,
        cursor: c.req.query("cursor") || undefined,
        titleField,
      });

      return c.json({
        ok: true,
        items: result.items,
        meta: {
          total: result.total,
          limit: limit ?? 200,
          next_cursor: result.next_cursor,
          scope: {
            restricted: hasRecordRestrictions(restrictions),
            archived: includeArchived ? "included" : "excluded",
          },
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
      cursor: c.req.query("cursor") || undefined,
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
    // The credential check ran in the router middleware on this same GET
    // path, so a metadata read needs exactly the read side of the key. A
    // `meta` other than `1` throws a ZodError, answered as a 400.
    const query = RecordGetQuerySchema.parse({
      meta: c.req.queries("meta"),
    });

    if (query.meta) {
      const meta = recordOps.getRecordMeta(deps.db, type, key);
      if (!meta) {
        return jsonError(
          c,
          404,
          "not-found",
          `Record ${type}/${key} not found`,
        );
      }
      return c.json({ ok: true, meta });
    }

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
