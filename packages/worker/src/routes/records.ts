import { R2ArtifactBackend } from "@tila/backend-r2";
import {
  RecordArchiveRequestSchema,
  RecordCreateRequestSchema,
  RecordPatchRequestSchema,
  RecordPutRequestSchema,
  RecordSetRequestSchema,
  RecordUnarchiveRequestSchema,
  RecordValueSchema,
  canonicalJson,
  canonicalJsonSha256,
  parseTagFilter,
} from "@tila/schemas";
import { Hono } from "hono";
import { ZodError } from "zod";
import { analyticsCtxFrom } from "../lib/analytics";
import { DO_PATHS, forwardTypedDO } from "../lib/do-contract";
import { forwardToDO, idempotencyHeaders } from "../lib/do-forward";
import { getValidatedSchema } from "../lib/schema-validation";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

export const records = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

// ---------------------------------------------------------------------------
// Snapshot artifact helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Returns the `history` mode for the given record type. Fail-open: returns
 * "revision" if schema is unavailable, unparseable, or type is undeclared.
 *
 * Uses the per-isolate schema cache (30s TTL) — no per-write DO round-trip.
 */
async function resolveRecordHistoryMode(
  stub: DurableObjectStub,
  projectId: string,
  type: string,
): Promise<"revision" | "snapshot"> {
  const result = await getValidatedSchema(stub, projectId);
  if (!result.ok) return "revision";
  return result.schema.records?.[type]?.history ?? "revision";
}

/**
 * Validates a caller-supplied source_artifact_key by querying the DO's
 * artifact pointers. Returns { ok: true } if valid, { ok: false, message }
 * if the pointer does not exist with the correct kind/resource.
 */
async function validateSourceArtifactKey(
  stub: DurableObjectStub,
  sourceKey: string,
  type: string,
  key: string,
  analyticsCtx: ReturnType<typeof analyticsCtxFrom>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const resource = `record:${type}/${key}`;
    const { response: res, json: body } = await forwardTypedDO<{
      ok: boolean;
      pointers: Array<{ r2_key: string }>;
    }>(
      stub,
      DO_PATHS.artifactPointers,
      "GET",
      undefined,
      {
        resource,
        kind: "record-snapshot-source",
        limit: "100",
      },
      analyticsCtx,
    );
    if (!res.ok) {
      return { ok: false, message: "Failed to validate source artifact key" };
    }
    if (!body.ok || !body.pointers) {
      return { ok: false, message: "Failed to validate source artifact key" };
    }
    const found = body.pointers.some((p) => p.r2_key === sourceKey);
    if (!found) {
      return {
        ok: false,
        message: `source_artifact_key "${sourceKey}" not found with kind "record-snapshot-source" and resource "${resource}"`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Failed to validate source artifact key" };
  }
}

/**
 * Writes canonical JSON to R2 as a content-addressed snapshot.
 * Returns the R2 key and byte length. Uses the `produced/<resource>/<sha256>.json` convention.
 */
async function writeCanonicalSnapshot(
  env: Env,
  type: string,
  key: string,
  canonicalJsonStr: string,
  sha256: string,
  actor: string,
): Promise<{ r2Key: string; bytes: number }> {
  const resource = `record:${type}/${key}`;
  const r2Key = `produced/${resource}/${sha256}.json`;
  const encoded = new TextEncoder().encode(canonicalJsonStr);
  const r2 = new R2ArtifactBackend(env.ARTIFACTS);
  await r2.put({
    key: r2Key,
    body: encoded.buffer as ArrayBuffer,
    sha256,
    contentType: "application/json",
    metadata: {
      "tila-task": resource,
      "tila-fence": "",
      "tila-machine": actor,
      "tila-kind": "record-snapshot-canonical",
      "tila-sha256": sha256,
      "tila-mime": "application/json",
    },
  });
  return { r2Key, bytes: encoded.byteLength };
}

// GET /records/_types -> merge declared schema types + DO in-use types
// CRITICAL: must be registered BEFORE any /:type route to avoid "_types" matching as :type
records.get("/_types", async (c) => {
  const stub = c.get("doStub");

  // 1. Fetch in-use types from DO
  let inUseTypes: string[] = [];
  try {
    const { response: inUseRes, json: inUseBody } = await forwardTypedDO<{
      ok: boolean;
      types: string[];
    }>(
      stub,
      DO_PATHS.recordTypesInUse,
      "GET",
      undefined,
      undefined,
      analyticsCtxFrom(c),
    );
    if (inUseRes.ok && inUseBody.ok) {
      inUseTypes = inUseBody.types;
    }
  } catch {
    // Fail open -- inUseTypes stays empty
  }

  // 2. Fetch declared types from schema TOML (via per-isolate cache — no extra DO round-trip)
  let declaredTypes: string[] = [];
  const schemaResult = await getValidatedSchema(stub, c.get("projectId"));
  if (schemaResult.ok) {
    declaredTypes = Object.keys(schemaResult.schema.records ?? {}).sort();
  }
  // schema absent, parse error, or validate error: declaredTypes stays empty (permissive)

  // 3. Merge, deduplicate, sort
  const types = [...new Set([...declaredTypes, ...inUseTypes])].sort();

  return c.json({
    ok: true,
    types,
    declared_types: declaredTypes,
    in_use_types: inUseTypes,
  });
});

// GET /records/:type/~/history/:key -> DO GET /record/:type/:key/history
// CRITICAL: must be registered before /:type/:key{.+} to avoid "~/history" matching as key
records.get("/:type/~/history/:key{.+}", async (c) => {
  const { type, key } = c.req.param();
  const stub = c.get("doStub");
  const query: Record<string, string> = {};
  const limit = c.req.query("limit");
  if (limit) query.limit = limit;
  const values = c.req.query("values");
  if (values) query.values = values;
  return forwardToDO(
    stub,
    `/record/${type}/${key}/history`,
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});

// POST /records/:type/~/archive/:key -> DO POST /record/:type/:key/archive
// CRITICAL: must be registered before /:type/:key{.+} to avoid "~/archive" matching as key
records.post(
  "/:type/~/archive/:key{.+}",
  requirePermission("write"),
  async (c) => {
    const { type, key } = c.req.param();
    const raw = await c.req.json();
    const parsed = RecordArchiveRequestSchema.safeParse(raw);
    if (!parsed.success) return zodValidationError(c, parsed.error);
    const stub = c.get("doStub");
    const tokenResult = c.get("tokenResult");
    return forwardToDO(
      stub,
      `/record/${type}/${key}/archive`,
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
      idempotencyHeaders(c),
    );
  },
);

// POST /records/:type/~/unarchive/:key -> DO POST /record/:type/:key/unarchive
// CRITICAL: must be registered before /:type/:key{.+} to avoid "~/unarchive" matching as key
records.post(
  "/:type/~/unarchive/:key{.+}",
  requirePermission("write"),
  async (c) => {
    const { type, key } = c.req.param();
    const raw = await c.req.json();
    const parsed = RecordUnarchiveRequestSchema.safeParse(raw);
    if (!parsed.success) return zodValidationError(c, parsed.error);
    const stub = c.get("doStub");
    const tokenResult = c.get("tokenResult");
    return forwardToDO(
      stub,
      `/record/${type}/${key}/unarchive`,
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
      idempotencyHeaders(c),
    );
  },
);

// POST /records/:type/~/put/:key -> DO POST /record/:type/:key/put
// Fenceless create-or-replace (upsert). CRITICAL: must be registered before
// /:type/:key{.+} (to avoid "~/put" matching as a key) and before the
// POST /:type create catch-all.
records.post("/:type/~/put/:key{.+}", requirePermission("write"), async (c) => {
  const { type, key } = c.req.param();
  const raw = await c.req.json();
  const parsed = RecordPutRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  // 64 KiB boundary guard -- fires before DO call
  const sizeCheck = RecordValueSchema.safeParse(parsed.data.value);
  if (!sizeCheck.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "payload-too-large",
          message: "Value exceeds 64 KiB canonical JSON limit",
          retryable: false,
        },
      },
      413,
    );
  }

  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  const actor = tokenResult.name;
  const analyticsCtx = analyticsCtxFrom(c);

  // Snapshot artifact flow: resolve history mode before DO call
  const historyMode = await resolveRecordHistoryMode(
    stub,
    c.get("projectId"),
    type,
  );

  // Validate source_artifact_key if present
  if (parsed.data.source_artifact_key) {
    if (historyMode !== "snapshot") {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message:
              "source_artifact_key is only valid for history=snapshot record types",
            retryable: false,
          },
        },
        422,
      );
    }
    const sourceCheck = await validateSourceArtifactKey(
      stub,
      parsed.data.source_artifact_key,
      type,
      key,
      analyticsCtx,
    );
    if (!sourceCheck.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: sourceCheck.message,
            retryable: false,
          },
        },
        422,
      );
    }
  }

  // For snapshot types: write R2 BEFORE DO call (R2-before-DO invariant)
  let canonicalArtifactKey: string | null = null;
  if (historyMode === "snapshot") {
    const canonical = canonicalJson(parsed.data.value);
    const sha256 = await canonicalJsonSha256(parsed.data.value);
    const snapshot = await writeCanonicalSnapshot(
      c.env,
      type,
      key,
      canonical,
      sha256,
      actor,
    );
    canonicalArtifactKey = snapshot.r2Key;
  }

  return forwardToDO(
    stub,
    `/record/${type}/${key}/put`,
    "POST",
    {
      ...parsed.data,
      canonical_artifact_key: canonicalArtifactKey,
      actor,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtx,
  );
});

// GET /records/:type/:key -> DO GET /record/:type/:key
records.get("/:type/:key{.+}", async (c) => {
  const { type, key } = c.req.param();
  const stub = c.get("doStub");
  return forwardToDO(
    stub,
    `/record/${type}/${key}`,
    "GET",
    undefined,
    undefined,
    analyticsCtxFrom(c),
  );
});

// PUT /records/:type/:key -> DO POST /record/:type/:key/set
records.put("/:type/:key{.+}", requirePermission("write"), async (c) => {
  const { type, key } = c.req.param();
  const raw = await c.req.json();
  const parsed = RecordSetRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  // 64 KiB boundary guard -- fires before DO call
  const sizeCheck = RecordValueSchema.safeParse(parsed.data.value);
  if (!sizeCheck.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "payload-too-large",
          message: "Value exceeds 64 KiB canonical JSON limit",
          retryable: false,
        },
      },
      413,
    );
  }

  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  const actor = tokenResult.name;
  const analyticsCtx = analyticsCtxFrom(c);

  // Snapshot artifact flow: resolve history mode before DO call
  const historyMode = await resolveRecordHistoryMode(
    stub,
    c.get("projectId"),
    type,
  );

  // Validate source_artifact_key if present
  if (parsed.data.source_artifact_key) {
    if (historyMode !== "snapshot") {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message:
              "source_artifact_key is only valid for history=snapshot record types",
            retryable: false,
          },
        },
        422,
      );
    }
    const sourceCheck = await validateSourceArtifactKey(
      stub,
      parsed.data.source_artifact_key,
      type,
      key,
      analyticsCtx,
    );
    if (!sourceCheck.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: sourceCheck.message,
            retryable: false,
          },
        },
        422,
      );
    }
  }

  // For snapshot types: write R2 BEFORE DO call (R2-before-DO invariant)
  let canonicalArtifactKey: string | null = null;
  if (historyMode === "snapshot") {
    const canonical = canonicalJson(parsed.data.value);
    const sha256 = await canonicalJsonSha256(parsed.data.value);
    const snapshot = await writeCanonicalSnapshot(
      c.env,
      type,
      key,
      canonical,
      sha256,
      actor,
    );
    canonicalArtifactKey = snapshot.r2Key;
  }

  return forwardToDO(
    stub,
    `/record/${type}/${key}/set`,
    "POST",
    {
      ...parsed.data,
      canonical_artifact_key: canonicalArtifactKey,
      actor,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtx,
    idempotencyHeaders(c),
  );
});

// PATCH /records/:type/:key -> DO POST /record/:type/:key/patch
records.patch("/:type/:key{.+}", requirePermission("write"), async (c) => {
  const { type, key } = c.req.param();
  const raw = await c.req.json();
  const parsed = RecordPatchRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  const actor = tokenResult.name;
  const analyticsCtx = analyticsCtxFrom(c);

  // Check history mode before mutation (fail-open: if schema unavailable, treat as revision)
  const historyMode = await resolveRecordHistoryMode(
    stub,
    c.get("projectId"),
    type,
  );

  // Forward patch to DO (DO performs merge-patch and returns the merged value)
  const doResponse = await forwardToDO(
    stub,
    `/record/${type}/${key}/patch`,
    "POST",
    {
      ...parsed.data,
      actor,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtx,
    idempotencyHeaders(c),
  );

  // If not snapshot type or DO call failed, return response as-is
  if (historyMode !== "snapshot" || !doResponse.ok) {
    return doResponse;
  }

  // Two-phase stamp flow for snapshot types:
  // 1. Parse DO response to get the merged value and revision
  // 2. Write canonical JSON to R2
  // 3. Call DO stamp-artifacts endpoint (best-effort)
  try {
    type PatchResponseBody = {
      ok: boolean;
      record: {
        value: Record<string, unknown>;
        value_sha256: string;
      };
      revision: number;
      fence: number;
    };
    const responseBody = (await doResponse.json()) as PatchResponseBody;

    if (!responseBody.ok) {
      return c.json(
        responseBody,
        doResponse.status as 400 | 404 | 409 | 422 | 500,
      );
    }

    // Compute canonical JSON and write to R2
    const canonical = canonicalJson(responseBody.record.value);
    const sha256 = await canonicalJsonSha256(responseBody.record.value);

    let snapshot: { r2Key: string; bytes: number } | null = null;
    try {
      snapshot = await writeCanonicalSnapshot(
        c.env,
        type,
        key,
        canonical,
        sha256,
        actor,
      );
    } catch (snapshotErr) {
      console.warn(
        `Snapshot R2 write failed for patch of record ${type}/${key}:`,
        snapshotErr,
      );
      // R2 failure after DO patch -- revision has null canonical_artifact_key
      // This is acceptable per spec -- not a dangling DO reference
      return c.json(responseBody, doResponse.status as 200);
    }

    // Stamp artifacts on the revision row (best-effort)
    try {
      await forwardToDO(
        stub,
        `/record/${type}/${key}/stamp-artifacts`,
        "POST",
        {
          revision: responseBody.revision,
          canonical_artifact_key: snapshot.r2Key,
          source_artifact_key: null,
          sha256,
          bytes: snapshot.bytes,
          actor,
        },
        undefined,
        analyticsCtx,
      );
    } catch (stampErr) {
      console.warn(
        `stamp-artifacts failed for record ${type}/${key} revision ${responseBody.revision}:`,
        stampErr,
      );
      // Stamp is best-effort -- return original patch response
    }

    // Return the DO patch response (re-serialized since we consumed the body)
    return c.json(responseBody, doResponse.status as 200);
  } catch (err) {
    console.warn(
      `Unexpected error in snapshot patch flow for record ${type}/${key}:`,
      err,
    );
    // Fall through -- cannot return doResponse since body already consumed
    return c.json(
      {
        ok: false,
        error: {
          code: "internal",
          message: "Snapshot patch flow error",
          retryable: true,
        },
      },
      500,
    );
  }
});

// GET /records/:type -> DO GET /record/:type/list
records.get("/:type", async (c) => {
  const { type } = c.req.param();
  const stub = c.get("doStub");
  const query: Record<string, string> = {};
  const tag = c.req.query("tag");
  if (tag) query.tag = tag;
  const includeArchived = c.req.query("include-archived");
  if (includeArchived) query.includeArchived = includeArchived;
  const limit = c.req.query("limit");
  if (limit) query.limit = limit;
  const filter = c.req.query("filter");
  if (filter) {
    // Validate JSON at Worker boundary before forwarding
    try {
      JSON.parse(filter);
      query.dataFilter = filter;
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: "filter must be valid JSON",
            retryable: false,
          },
        },
        400,
      );
    }
  }
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
    `/record/${type}/list`,
    "GET",
    undefined,
    query,
    analyticsCtxFrom(c),
  );
});

// POST /records/:type -> DO POST /record/:type/create
records.post("/:type", requirePermission("write"), async (c) => {
  const { type } = c.req.param();
  const raw = await c.req.json();
  const parsed = RecordCreateRequestSchema.safeParse(raw);
  if (!parsed.success) return zodValidationError(c, parsed.error);

  // 64 KiB boundary guard -- fires before DO call
  const sizeCheck = RecordValueSchema.safeParse(parsed.data.value);
  if (!sizeCheck.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "payload-too-large",
          message: "Value exceeds 64 KiB canonical JSON limit",
          retryable: false,
        },
      },
      413,
    );
  }

  const stub = c.get("doStub");
  const tokenResult = c.get("tokenResult");
  const actor = tokenResult.name;
  const analyticsCtx = analyticsCtxFrom(c);
  const recordKey = parsed.data.key;

  // Snapshot artifact flow: resolve history mode before DO call
  const historyMode = await resolveRecordHistoryMode(
    stub,
    c.get("projectId"),
    type,
  );

  // Validate source_artifact_key if present
  if (parsed.data.source_artifact_key) {
    if (historyMode !== "snapshot") {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message:
              "source_artifact_key is only valid for history=snapshot record types",
            retryable: false,
          },
        },
        422,
      );
    }
    const sourceCheck = await validateSourceArtifactKey(
      stub,
      parsed.data.source_artifact_key,
      type,
      recordKey,
      analyticsCtx,
    );
    if (!sourceCheck.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: sourceCheck.message,
            retryable: false,
          },
        },
        422,
      );
    }
  }

  // For snapshot types: write R2 BEFORE DO call (R2-before-DO invariant)
  let canonicalArtifactKey: string | null = null;
  if (historyMode === "snapshot") {
    const canonical = canonicalJson(parsed.data.value);
    const sha256 = await canonicalJsonSha256(parsed.data.value);
    const snapshot = await writeCanonicalSnapshot(
      c.env,
      type,
      recordKey,
      canonical,
      sha256,
      actor,
    );
    canonicalArtifactKey = snapshot.r2Key;
  }

  return forwardToDO(
    stub,
    `/record/${type}/create`,
    "POST",
    {
      ...parsed.data,
      canonical_artifact_key: canonicalArtifactKey,
      actor,
      actor_token_id: tokenResult.tokenId,
      source: c.get("source"),
      source_version: c.get("sourceVersion"),
    },
    undefined,
    analyticsCtx,
  );
});
