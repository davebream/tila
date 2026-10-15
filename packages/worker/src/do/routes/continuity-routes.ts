import {
  continuityOps,
  journalVisibilityOps,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
import { IdentityContextSchema, hasNamespaceRestrictions } from "@tila/schemas";
import { Hono } from "hono";
import { createR2JournalArchiveReader } from "../../r2";
import { jsonError } from "./responses";
import type { RouterDeps } from "./types";

export function createContinuityRoutes(deps: RouterDeps) {
  const app = new Hono();
  const number = (value: string | undefined) =>
    value === undefined ? undefined : Number(value);
  app.get("/journal/replay", async (c) => {
    const input = {
      after_seq: Number(c.req.query("after_seq")),
      through_seq: number(c.req.query("through_seq")),
      limit: number(c.req.query("limit")),
      event_name: c.req.query("event_name"),
      correlation_id: c.req.query("correlation_id"),
    };
    const policy = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    );
    // A namespace-restricted credential is answered here, in full: the raw
    // snapshot holds events it may not read and never leaves the DO for it.
    if (policy && hasNamespaceRestrictions(policy)) {
      const projectId = c.req.query("project_id");
      if (!projectId)
        return jsonError(c, 400, "bad-request", "project_id is required");
      return c.json(
        await journalVisibilityOps.scopedReplay(
          deps.db,
          policy,
          input,
          deps.artifacts
            ? createR2JournalArchiveReader(deps.artifacts, projectId)
            : undefined,
        ),
      );
    }
    return c.json(
      deps.db.transaction((tx) => continuityOps.replaySnapshot(tx, input)),
    );
  });
  app.get("/journal/cursor", (c) =>
    c.json({
      ok: true,
      cursor: continuityOps.getCursor(
        deps.db,
        IdentityContextSchema.parse(c.req.query()),
      ),
    }),
  );
  app.put("/journal/cursor", async (c) => {
    const body = await c.req.json();
    return c.json({
      ok: true,
      cursor: continuityOps.acknowledge(
        deps.db,
        IdentityContextSchema.parse(body.identity),
        body.input,
      ),
    });
  });
  app.post("/handoffs", async (c) => {
    const body = await c.req.json();
    return c.json({
      ok: true,
      handoff: continuityOps.createHandoff(
        deps.db,
        IdentityContextSchema.parse(body.identity),
        body.input,
      ),
    });
  });
  app.get("/handoffs", (c) =>
    c.json(
      continuityOps.listHandoffs(
        deps.db,
        IdentityContextSchema.parse(c.req.query()),
        {
          resource: c.req.query("resource"),
          before_seq: number(c.req.query("before_seq")),
          limit: number(c.req.query("limit")),
        },
      ),
    ),
  );
  app.get("/handoffs/:id", (c) => {
    const handoff = continuityOps.getHandoff(deps.db, c.req.param("id"));
    return handoff
      ? c.json({ ok: true, handoff })
      : c.json(
          {
            ok: false,
            error: {
              code: "handoff-not-found",
              message: "Handoff does not exist",
              retryable: false,
            },
          },
          404,
        );
  });
  app.get("/reentry", (c) =>
    c.json(
      continuityOps.reentrySnapshot(
        deps.db,
        IdentityContextSchema.parse(c.req.query()),
        {
          after_seq: number(c.req.query("after_seq")),
          through_seq: number(c.req.query("through_seq")),
          limit: number(c.req.query("limit")),
          handoff_id: c.req.query("handoff_id"),
          resource: c.req.query("resource"),
        },
      ),
    ),
  );
  return app;
}
