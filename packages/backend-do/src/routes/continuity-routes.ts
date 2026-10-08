import { continuityOps } from "@tila/ops-sqlite";
import { IdentityContextSchema } from "@tila/schemas";
import { Hono } from "hono";
import type { RouterDeps } from "./types";

export function createContinuityRoutes(deps: RouterDeps) {
  const app = new Hono();
  const number = (value: string | undefined) =>
    value === undefined ? undefined : Number(value);
  app.get("/journal/replay", (c) =>
    c.json(
      deps.db.transaction((tx) =>
        continuityOps.replaySnapshot(tx, {
          after_seq: Number(c.req.query("after_seq")),
          through_seq: number(c.req.query("through_seq")),
          limit: number(c.req.query("limit")),
        }),
      ),
    ),
  );
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
