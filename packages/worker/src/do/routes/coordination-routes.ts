import {
  CredentialPolicyDenied,
  assertResourceAccess,
  filterRelationships,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
import {
  type RequestOrigin,
  coordinationOps,
  journalArchiveOps,
  journalOps,
  journalVisibilityOps,
  resolveEntityResource,
} from "@tila/ops-sqlite";
import { hasNamespaceRestrictions } from "@tila/schemas";
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
    const policy = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    );
    const claims = coordinationOps.listClaims(db).filter((claim) => {
      if (!policy || !hasNamespaceRestrictions(policy)) return true;
      try {
        // Listing claims reveals which resources are held: a read.
        assertResourceAccess(db, policy, claim.resource, "read");
        return true;
      } catch (error) {
        if (error instanceof CredentialPolicyDenied) return false;
        throw error;
      }
    });
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
    const resourcesRaw = c.req.query("resources");
    const resource: string | string[] | undefined = resourcesRaw
      ? (JSON.parse(resourcesRaw) as string[])
      : (c.req.query("resource") ?? undefined);
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
    const policy = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    );
    const listQuery = {
      resource,
      kind,
      client_name,
      event_name: c.req.query("event_name"),
      correlation_id: c.req.query("correlation_id"),
      after_seq,
      limit,
    };
    // A namespace-restricted credential sees only the events it may read, and
    // never the raw list.
    if (policy && hasNamespaceRestrictions(policy)) {
      if (
        limit !== undefined &&
        !(
          Number.isInteger(limit) &&
          limit >= 1 &&
          limit <= journalVisibilityOps.SCOPED_LIST_MAX_LIMIT
        )
      )
        return jsonError(
          c,
          400,
          "validation-error",
          `limit must be an integer from 1 to ${journalVisibilityOps.SCOPED_LIST_MAX_LIMIT}`,
        );
      if (
        after_seq !== undefined &&
        !(Number.isSafeInteger(after_seq) && after_seq >= 0)
      )
        return jsonError(
          c,
          400,
          "validation-error",
          "after_seq must be a non-negative integer",
        );
      const scoped = journalVisibilityOps.listScopedJournal(
        db,
        policy,
        listQuery,
        watermark ?? undefined,
      );
      const state = journalOps.journalArchiveState(after_seq, watermark);
      // `has_more` is what separates "caught up" from "stopped early": the
      // scan of a restricted list is bounded, and a short page alone is not
      // an answer.
      return c.json({
        ok: true,
        events: scoped.events,
        archived: state.archived,
        lastArchivedSeq: state.lastArchivedSeq,
        has_more: scoped.has_more,
        ...(scoped.next_after_seq !== undefined && {
          next_after_seq: scoped.next_after_seq,
        }),
      });
    }
    const events = journalOps.listJournal(
      db,
      listQuery,
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
