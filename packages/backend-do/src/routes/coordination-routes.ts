import {
  type RequestOrigin,
  coordinationOps,
  journalArchiveOps,
  journalOps,
  resolveEntityResource,
} from "@tila/ops-sqlite";
import {
  AcquireRequestSchema,
  PresenceHeartbeatRequestSchema,
  ReleaseRequestSchema,
  RenewRequestSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { formatZodIssues, idempotencyFrom, jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

const DoAcquireRequestSchema = AcquireRequestSchema.extend({
  machine: z.string().min(1),
  user: z.string().min(1),
  actor_token_id: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  source_version: z.string().nullable().optional(),
});

const DoRenewRequestSchema = RenewRequestSchema.extend({
  machine: z.string().min(1),
  user: z.string().min(1),
  actor_token_id: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  source_version: z.string().nullable().optional(),
});

const DoReleaseRequestSchema = ReleaseRequestSchema.extend({
  actor: z.string().min(1),
  actor_token_id: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  source_version: z.string().nullable().optional(),
});

export function createCoordinationRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/coord/acquire", async (c) => {
    const { db } = deps;
    const parsed = DoAcquireRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    const body = parsed.data;
    const resource = resolveEntityResource(db, body.resource) ?? body.resource;
    const origin: RequestOrigin = {
      actor: body.user,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    const result = coordinationOps.acquire(
      db,
      resource,
      body.machine,
      body.user,
      body.mode,
      body.ttl_ms,
      body.metadata,
      Date.now(),
      origin,
      idempotencyFrom(c),
    );
    if (!result.acquired) {
      return jsonError(
        c,
        409,
        "already-held",
        `Resource ${resource} already held`,
      );
    }
    return c.json({
      ok: true,
      fence: result.fence,
      expires_at: result.expires_at,
    });
  });

  app.post("/coord/renew", async (c) => {
    const { db } = deps;
    const parsed = DoRenewRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    const body = parsed.data;
    const resource = resolveEntityResource(db, body.resource) ?? body.resource;
    const renewOrigin: RequestOrigin = {
      actor: body.user,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    const result = coordinationOps.renew(
      db,
      resource,
      body.machine,
      body.user,
      body.fence,
      body.ttl_ms,
      Date.now(),
      renewOrigin,
      idempotencyFrom(c),
    );
    if (!result.renewed) {
      return jsonError(
        c,
        409,
        "renew-failed",
        "Claim not found, expired, or holder mismatch",
      );
    }
    return c.json({ ok: true, expires_at: result.expires_at });
  });

  app.post("/coord/release", async (c) => {
    const { db } = deps;
    const parsed = DoReleaseRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    const body = parsed.data;
    const resource = resolveEntityResource(db, body.resource) ?? body.resource;
    const releaseOrigin: RequestOrigin = {
      actor: body.actor,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    coordinationOps.release(
      db,
      resource,
      body.fence,
      releaseOrigin,
      idempotencyFrom(c),
    );
    return c.json({ ok: true });
  });

  app.get("/coord/claims", (c) => {
    const { db } = deps;
    const claims = coordinationOps.listClaims(db);
    return c.json({ ok: true, claims });
  });

  app.get("/coord/state", (c) => {
    const { db } = deps;
    const resource = c.req.query("resource");
    if (!resource) {
      return jsonError(c, 400, "bad-request", "resource query param required");
    }
    const canonicalResource = resolveEntityResource(db, resource) ?? resource;
    const claim = coordinationOps.state(db, canonicalResource);
    return c.json({ ok: true, claim });
  });

  app.post("/coord/heartbeat", async (c) => {
    const { db } = deps;
    const parsed = PresenceHeartbeatRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    const body = parsed.data;
    coordinationOps.heartbeat(db, body.machine, body.info);
    return c.json({ ok: true });
  });

  app.get("/coord/presence/all", (c) => {
    const { db } = deps;
    const machines = coordinationOps.listAllPresence(db);
    return c.json({ ok: true, machines });
  });

  app.get("/coord/presence", (c) => {
    const { db } = deps;
    const machines = coordinationOps.listPresence(db);
    return c.json({ ok: true, machines });
  });

  app.get("/coord/health", (c) => {
    const { db } = deps;
    const expiredClaimsCount = coordinationOps.countExpiredClaims(db);
    const stats = journalOps.journalStats(db);
    return c.json({
      ok: true,
      expiredClaimsCount,
      journalRows: stats.journalRows,
      maxSeq: stats.maxSeq,
    });
  });

  app.get("/journal/list", (c) => {
    const { db } = deps;
    const resource = c.req.query("resource") ?? undefined;
    const kindRaw = c.req.query("kind");
    const kind = kindRaw?.includes(",")
      ? kindRaw.split(",").filter(Boolean)
      : (kindRaw ?? undefined);
    const sourceRaw = c.req.query("source");
    const source = sourceRaw?.includes(",")
      ? sourceRaw.split(",").filter(Boolean)
      : (sourceRaw ?? undefined);
    const afterSeqParam = c.req.query("after_seq");
    const after_seq = afterSeqParam ? Number(afterSeqParam) : undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    // Thread the archival watermark so a cursor below it yields an explicit
    // "archived" indicator instead of an ambiguous empty list. Recent
    // {limit:N} reads (no after_seq) are unaffected: archived stays false.
    const watermark = journalArchiveOps.getArchiveWatermark(db);
    const events = journalOps.listJournal(
      db,
      {
        resource,
        kind,
        source,
        after_seq,
        limit,
      },
      watermark ?? undefined,
    );
    const { archived, lastArchivedSeq } = journalOps.journalArchiveState(
      after_seq,
      watermark,
    );
    return c.json({ ok: true, events, archived, lastArchivedSeq });
  });

  return app;
}
