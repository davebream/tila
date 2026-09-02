import {
  type RequestOrigin,
  coordinationOps,
  journalArchiveOps,
  journalOps,
  resolveEntityResource,
} from "@tila/ops-sqlite";
import {
  AcquireRequestSchema,
  EnvironmentMetadataSchema,
  ParticipantIdSchema,
  PresenceHeartbeatRequestSchema,
  ReleaseRequestSchema,
  RenewRequestSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { originFromBody } from "./origin";
import { formatZodIssues, idempotencyFrom, jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

const identityFields = {
  principal_id: z.string().min(1),
  participant_id: ParticipantIdSchema,
  environment: EnvironmentMetadataSchema,
  actor_token_id: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  source_version: z.string().nullable().optional(),
};

const DoAcquireRequestSchema = AcquireRequestSchema.extend(identityFields);

const DoRenewRequestSchema = RenewRequestSchema.extend(identityFields);

const DoReleaseRequestSchema = ReleaseRequestSchema.extend(identityFields);
const DoHeartbeatRequestSchema =
  PresenceHeartbeatRequestSchema.extend(identityFields);

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
    const origin = originFromBody(body);
    const result = coordinationOps.acquire(
      db,
      resource,
      origin,
      body.mode,
      body.ttl_ms,
      body.metadata,
      Date.now(),
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
      participant_id: result.participant_id,
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
    const renewOrigin = originFromBody(body);
    const result = coordinationOps.renew(
      db,
      resource,
      renewOrigin,
      body.fence,
      body.ttl_ms,
      Date.now(),
      idempotencyFrom(c),
    );
    if (!result.renewed) {
      return jsonError(
        c,
        409,
        "renew-failed",
        "Claim not found, expired, or participant mismatch",
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
    const releaseOrigin = originFromBody(body);
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
    const parsed = DoHeartbeatRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "validation-error",
        formatZodIssues(parsed.error.issues),
      );
    }
    const body = parsed.data;
    coordinationOps.heartbeat(db, originFromBody(body), body.info);
    return c.json({ ok: true });
  });

  app.get("/coord/presence/all", (c) => {
    const { db } = deps;
    const participants = coordinationOps.listAllPresence(db);
    return c.json({ ok: true, participants });
  });

  app.get("/coord/presence", (c) => {
    const { db } = deps;
    const participants = coordinationOps.listPresence(db);
    return c.json({ ok: true, participants });
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
    const clientNameRaw = c.req.query("client_name");
    const client_name = clientNameRaw?.includes(",")
      ? clientNameRaw.split(",").filter(Boolean)
      : (clientNameRaw ?? undefined);
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
        client_name,
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
