import {
  type RequestOrigin,
  artifactOps,
  constraintOps,
  relationshipOps,
  searchDriftOps,
  searchReindexOps,
} from "@tila/ops-sqlite";
import { parseTagFilter } from "@tila/schemas";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { ZodError } from "zod";
import type { ReindexState } from "../project-do";
import { jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

function parseMulti(value: string | undefined): string | string[] | undefined {
  if (!value) return undefined;
  return value.includes(",") ? value.split(",").filter(Boolean) : value;
}

const {
  checkArtifactKindDeclared,
  checkArtifactKindSearchable,
  checkArtifactRelationshipTypeDeclared,
  getArtifactKindRetention,
  getAutoSupersedes,
  resolveCurrentSchema,
} = constraintOps;

export function createArtifactRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/artifact/pointer", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      r2_key: string;
      resource: string | null;
      kind: string;
      sha256: string;
      bytes: number;
      fence: number | null;
      mime_type: string;
      produced_at: number;
      produced_by: string;
      expires_at: number | null;
      actor: string;
      search_title?: string | null;
      search_body_text?: string | null;
      content_inline?: string | null;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
      tags?: string[];
    };

    const parsedSchema = resolveCurrentSchema(db);
    if (parsedSchema) {
      const kindCheck = checkArtifactKindDeclared(parsedSchema, body.kind);
      if (!kindCheck.ok) {
        return jsonError(c, 422, kindCheck.code, kindCheck.message);
      }
    }

    let searchText: { title: string | null; body_text: string } | null = null;
    if (parsedSchema) {
      const searchability = checkArtifactKindSearchable(
        parsedSchema,
        body.kind,
      );
      if (searchability.searchable && body.search_body_text != null) {
        searchText = {
          title: body.search_title ?? null,
          body_text: body.search_body_text,
        };
      }
    }

    let computedExpiresAt: number | null = null;
    if (
      parsedSchema &&
      !body.r2_key.startsWith("indexes/") &&
      !body.r2_key.startsWith("sources/")
    ) {
      const retentionDays = getArtifactKindRetention(parsedSchema, body.kind);
      if (retentionDays > 0) {
        computedExpiresAt = body.produced_at + retentionDays * 86_400_000;
      }
    }

    const autoSupersedes = parsedSchema
      ? getAutoSupersedes(parsedSchema, body.kind)
      : false;

    const pointerOrigin: RequestOrigin = {
      actor: body.actor,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    artifactOps.upsertPointer(
      db,
      { ...body, expires_at: computedExpiresAt },
      pointerOrigin,
      undefined,
      searchText,
      autoSupersedes,
      body.tags,
    );
    return c.json({ ok: true });
  });

  app.get("/artifact/pointer-meta", (c) => {
    const { db } = deps;
    const key = c.req.query("key");
    if (!key) {
      return jsonError(c, 400, "missing-key", "key query param required");
    }
    const row = db.get<{
      r2_key: string;
      mime_type: string;
      content_inline: string | null;
      tombstoned: number;
    }>(
      sql`SELECT r2_key, mime_type, content_inline, tombstoned FROM artifact_pointers WHERE r2_key = ${key} LIMIT 1`,
    );
    if (!row || row.tombstoned === 1) {
      return jsonError(c, 404, "not-found", `Artifact ${key} not found`);
    }
    return c.json({
      ok: true,
      pointer: {
        r2_key: row.r2_key,
        mime_type: row.mime_type,
        content_inline: row.content_inline,
      },
    });
  });

  app.get("/artifact/pointers", (c) => {
    const { db } = deps;
    const resource = c.req.query("resource") ?? undefined;
    const kind = parseMulti(c.req.query("kind"));
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Number.parseInt(limitStr, 10), 100) : 100;

    const pointers = artifactOps.listPointers(db, {
      resource,
      kind,
      limit,
    });
    return c.json({ ok: true, pointers });
  });

  app.get("/artifact/list", (c) => {
    const { db } = deps;
    const resource = c.req.query("resource") ?? undefined;
    const kind = parseMulti(c.req.query("kind"));

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

    const pointers = artifactOps.listPointers(db, {
      resource,
      kind,
      tagFilter,
    });
    return c.json({ ok: true, pointers });
  });

  app.get("/artifact/latest", (c) => {
    const { db } = deps;
    const kind = c.req.query("kind");
    const resource = c.req.query("resource");
    if (!kind || !resource) {
      return jsonError(
        c,
        400,
        "validation-error",
        "kind and resource query params are required",
      );
    }
    const pointer = artifactOps.getLatestPointer(db, kind, resource);
    if (!pointer) {
      return c.json({ ok: false, error: "not-found" }, 404);
    }
    return c.json({ ok: true, pointer });
  });

  app.get("/artifact/grep-candidates", (c) => {
    const { db } = deps;
    const resource = c.req.query("resource") ?? undefined;
    const kind = parseMulti(c.req.query("kind"));
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Number.parseInt(limitStr, 10), 100) : 50;

    const candidates = artifactOps.listGrepCandidates(db, {
      resource,
      kind,
      limit,
      now: Date.now(),
    });
    return c.json({ ok: true, candidates });
  });

  app.get("/artifact/search", (c) => {
    const { db } = deps;
    const q = c.req.query("q");
    if (!q || q.trim() === "") {
      return jsonError(c, 400, "missing-query", "q parameter is required");
    }
    const kind = parseMulti(c.req.query("kind"));
    const resource = c.req.query("resource") ?? undefined;
    const source_only = c.req.query("source_only") === "true";
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
      const results = artifactOps.searchArtifacts(db, {
        q,
        kind,
        resource,
        source_only,
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

  app.post("/artifact/tombstone", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      r2_key: string;
      actor: string;
      journal_kind?: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const journalKind =
      body.journal_kind === "artifact.expired"
        ? ("artifact.expired" as const)
        : undefined;
    const tombstoneOrigin: RequestOrigin = {
      actor: body.actor,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    artifactOps.tombstonePointer(db, body.r2_key, tombstoneOrigin, journalKind);
    return c.json({ ok: true });
  });

  app.post("/artifact/reconcile", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      r2_blobs: Array<{
        key: string;
        size: number;
        metadata: Record<string, string>;
        search_title?: string | null;
        search_body_text?: string | null;
      }>;
      apply: boolean;
      actor: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const reconcileOrigin: RequestOrigin = {
      actor: body.actor,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    const existing = artifactOps.listPointers(db, { limit: 10000 });
    const existingKeys = new Set(
      existing.map((p: { r2_key: string }) => p.r2_key),
    );
    const orphans = body.r2_blobs.filter((b) => !existingKeys.has(b.key));
    const result = artifactOps.reconcilePointers(
      db,
      orphans,
      reconcileOrigin,
      body.apply,
    );
    return c.json({ ok: true, ...result });
  });

  // GET /artifact/searchable-pointers -- list non-tombstoned searchable pointer rows for reconcile
  app.get("/artifact/searchable-pointers", (c) => {
    const { db } = deps;
    const limitParam = c.req.query("limit");
    const limit = Math.min(Math.max(Number(limitParam) || 100, 1), 500);
    try {
      const pointers = artifactOps.listSearchablePointers(db, limit);
      return c.json({ ok: true, pointers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table") || msg.includes("no such column")) {
        return c.json({ ok: true, pointers: [] });
      }
      throw err;
    }
  });

  app.get("/artifact/search-rebuild-scan", (c) => {
    const { db } = deps;
    try {
      const rows = db.all<{
        artifact_key: string;
        kind: string;
        resource: string | null;
        sha256: string;
        mime_type: string;
        produced_at: number;
        pointer_tombstoned: number;
        existing_sha256: string | null;
        doc_tombstoned: number | null;
      }>(sql`
        SELECT
          ap.r2_key AS artifact_key,
          ap.kind,
          ap.resource,
          ap.sha256,
          ap.mime_type,
          ap.produced_at,
          ap.tombstoned AS pointer_tombstoned,
          asd.source_sha256 AS existing_sha256,
          asd.tombstoned AS doc_tombstoned
        FROM artifact_pointers ap
        LEFT JOIN artifact_search_docs asd ON ap.r2_key = asd.artifact_key
        LIMIT 1000
      `);
      return c.json({ ok: true, pointers: rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no such table")) {
        return c.json({ ok: true, pointers: [] });
      }
      throw err;
    }
  });

  app.post("/artifact/search-rebuild", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      candidates: artifactOps.SearchRebuildCandidate[];
      apply: boolean;
      actor: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const rebuildOrigin: RequestOrigin = {
      actor: body.actor,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    const result = artifactOps.rebuildSearchDocs(
      db,
      body.candidates,
      rebuildOrigin,
      body.apply,
    );
    return c.json({ ok: true, ...result });
  });

  app.post("/artifact/relationship", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      from_key: string;
      to_key: string;
      type: string;
      metadata?: Record<string, unknown>;
      actor: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    if (!body.from_key || !body.to_key || !body.type || !body.actor) {
      return jsonError(
        c,
        400,
        "validation-error",
        "from_key, to_key, type, and actor are required",
      );
    }

    const parsedSchema = resolveCurrentSchema(db);
    if (parsedSchema) {
      const relTypeCheck = checkArtifactRelationshipTypeDeclared(
        parsedSchema,
        body.type,
      );
      if (!relTypeCheck.ok) {
        return jsonError(c, 422, relTypeCheck.code, relTypeCheck.message);
      }
    }

    const relationshipOrigin: RequestOrigin = {
      actor: body.actor,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    artifactOps.addArtifactRelationship(
      db,
      body.from_key,
      body.to_key,
      body.type,
      body.metadata ?? {},
      relationshipOrigin,
    );
    return c.json({ ok: true });
  });

  app.get("/artifact/relationships", (c) => {
    const { db } = deps;
    const fromKey = c.req.query("from_key");
    if (!fromKey) {
      return jsonError(c, 400, "bad-request", "from_key query param required");
    }
    const relationships = relationshipOps.listArtifactRelationships(db, {
      from_key: fromKey,
    });
    return c.json({ ok: true, relationships });
  });

  app.get("/artifact/index/entries", (c) => {
    const { db } = deps;
    const indexKey = c.req.query("index_key");
    if (!indexKey) {
      return jsonError(c, 400, "bad-request", "index_key query param required");
    }
    const entries = artifactOps.listIndexEntries(db, indexKey);
    return c.json({ ok: true, entries });
  });

  app.get("/artifact/search-drift", (c) => {
    const { db } = deps;
    const parsedSchema = resolveCurrentSchema(db);
    const report = searchDriftOps.computeDrift(db, parsedSchema);
    return c.json({ ok: true as const, ...report });
  });

  // POST /search/reindex -- start a batched FTS reindex job via DO Alarms
  app.post("/search/reindex", async (c) => {
    const { ctx } = deps;
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: "artifact" | "entity";
    };

    if (body.kind !== "artifact" && body.kind !== "entity") {
      return jsonError(
        c,
        400,
        "validation-error",
        "kind must be 'artifact' or 'entity'",
      );
    }

    // Entity reindex is a full rebuild: clear existing docs so the batched alarm
    // loop re-indexes (and repairs) every entity, including rows indexed before the
    // data.title fix (issue #412). Scoped to entities; artifact reindex is unchanged.
    if (body.kind === "entity") {
      searchReindexOps.resetEntitySearchDocs(deps.db);
    }

    const state: ReindexState = {
      kind: body.kind,
      batchSize: 50,
      processed: 0,
    };

    await ctx.storage.put("_reindex_state", state);
    // Schedule first alarm immediately
    await ctx.storage.setAlarm(Date.now() + 10);

    return c.json({ ok: true, status: "started", kind: body.kind });
  });

  // GET /search/reindex/status -- check reindex job progress
  app.get("/search/reindex/status", async (c) => {
    const { ctx } = deps;
    const state = await ctx.storage.get<ReindexState>("_reindex_state");

    if (!state) {
      return c.json({ ok: true, status: "idle" });
    }

    return c.json({
      ok: true,
      status: "running",
      kind: state.kind,
      processed: state.processed,
    });
  });

  return app;
}
