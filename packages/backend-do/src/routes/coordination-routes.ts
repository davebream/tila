import {
  type RequestOrigin,
  coordinationOps,
  journalOps,
} from "@tila/ops-sqlite";
import { Hono } from "hono";
import { jsonError } from "./responses";
import type { ProjectSubRouter, RouterDeps } from "./types";

export function createCoordinationRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();

  app.post("/coord/acquire", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      resource: string;
      machine: string;
      user: string;
      mode: "exclusive" | "owner" | "presence";
      ttl_ms: number;
      metadata?: Record<string, unknown>;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const origin: RequestOrigin = {
      actor: body.user,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    const result = coordinationOps.acquire(
      db,
      body.resource,
      body.machine,
      body.user,
      body.mode,
      body.ttl_ms,
      body.metadata,
      Date.now(),
      origin,
    );
    if (!result.acquired) {
      return jsonError(
        c,
        409,
        "already-held",
        `Resource ${body.resource} already held`,
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
    const body = (await c.req.json()) as {
      resource: string;
      machine: string;
      user: string;
      fence: number;
      ttl_ms: number;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const renewOrigin: RequestOrigin = {
      actor: body.user,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    const result = coordinationOps.renew(
      db,
      body.resource,
      body.machine,
      body.user,
      body.fence,
      body.ttl_ms,
      Date.now(),
      renewOrigin,
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
    const body = (await c.req.json()) as {
      resource: string;
      fence: number;
      actor: string;
      actor_token_id?: string | null;
      source?: string | null;
      source_version?: string | null;
    };
    const releaseOrigin: RequestOrigin = {
      actor: body.actor,
      tokenId: body.actor_token_id ?? null,
      source: body.source ?? null,
      sourceVersion: body.source_version ?? null,
    };
    coordinationOps.release(db, body.resource, body.fence, releaseOrigin);
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
    const claim = coordinationOps.state(db, resource);
    return c.json({ ok: true, claim });
  });

  app.post("/coord/heartbeat", async (c) => {
    const { db } = deps;
    const body = (await c.req.json()) as {
      machine: string;
      info?: Record<string, unknown>;
    };
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
    const events = journalOps.listJournal(db, {
      resource,
      kind,
      source,
      after_seq,
      limit,
    });
    return c.json({ ok: true, events });
  });

  return app;
}
