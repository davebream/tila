import {
  DoIdempotencyConflictError,
  RevisionConflictError,
  agentBindingOps,
} from "@tila/ops-sqlite";
import {
  AgentIdSchema,
  AgentRegistrationSchema,
  ArchiveAgentSchema,
  AttachAgentBindingSchema,
  RUNTIME_VIEW_MAX_LIMIT,
  RuntimeIdentitySchema,
  UnarchiveAgentSchema,
  UpdateAgentSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { idempotencyFrom, jsonError } from "./responses";
import type { RouterDeps } from "./types";

const AuthoritySchema = z
  .object({
    principal_id: z.string().min(1),
    participant_id: z.string().min(1).optional(),
    can_manage: z.boolean(),
    runtime: RuntimeIdentitySchema.nullable(),
    acting_runtime: RuntimeIdentitySchema.nullable().optional(),
    terminal_run_id: z.string().uuid().nullable().optional(),
  })
  .strict();
type AgentEnv = { Variables: { authority: z.infer<typeof AuthoritySchema> } };

export function createAgentRoutes(deps: RouterDeps) {
  const app = new Hono<AgentEnv>();
  app.use("/agents/*", async (c, next) => {
    const authority = AuthoritySchema.safeParse(
      JSON.parse(c.req.header("X-Tila-Agent-Authority") ?? "null"),
    );
    if (!authority.success)
      return jsonError(
        c,
        403,
        "permission-denied",
        "Worker authority is required",
      );
    c.set("authority", authority.data);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof agentBindingOps.AgentBindingError)
      return jsonError(c, error.status, error.code, error.message);
    if (error instanceof RevisionConflictError)
      return jsonError(c, 412, "revision-conflict", error.message, {
        revision: error.revision,
        resource: error.resource,
      });
    if (error instanceof DoIdempotencyConflictError)
      return jsonError(
        c,
        422,
        "idempotency-key-conflict",
        "Idempotency-Key reused with a different request body",
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return jsonError(c, 400, "validation-error", "Invalid agent request");
    throw error;
  });
  const includeArchived = (value: string | undefined) => value === "true";
  app.get("/agents", (c) =>
    c.json({
      ok: true,
      agents: agentBindingOps.list(deps.db, c.get("authority"), {
        includeArchived: includeArchived(c.req.query("include_archived")),
      }),
    }),
  );
  app.post("/agents", async (c) =>
    c.json({
      ok: true,
      agent: agentBindingOps.register(
        deps.db,
        AgentRegistrationSchema.parse(await c.req.json()),
        c.get("authority"),
      ),
    }),
  );
  app.get("/agents/:id", (c) =>
    c.json({
      ok: true,
      ...agentBindingOps.view(
        deps.db,
        AgentIdSchema.parse(c.req.param("id")),
        c.get("authority"),
        { includeArchived: includeArchived(c.req.query("include_archived")) },
      ),
    }),
  );
  app.patch("/agents/:id", async (c) =>
    c.json({
      ok: true,
      agent: agentBindingOps.update(
        deps.db,
        AgentIdSchema.parse(c.req.param("id")),
        UpdateAgentSchema.parse(await c.req.json()),
        c.get("authority"),
        idempotencyFrom(c),
      ),
    }),
  );
  app.get("/agents/:id/archive-preview", (c) =>
    c.json({
      ok: true,
      preview: agentBindingOps.archivePreview(
        deps.db,
        AgentIdSchema.parse(c.req.param("id")),
        c.get("authority"),
      ),
    }),
  );
  app.post("/agents/:id/archive", async (c) =>
    c.json({
      ok: true,
      ...agentBindingOps.archive(
        deps.db,
        AgentIdSchema.parse(c.req.param("id")),
        ArchiveAgentSchema.parse(await c.req.json()),
        c.get("authority"),
        idempotencyFrom(c),
      ),
    }),
  );
  app.post("/agents/:id/unarchive", async (c) =>
    c.json({
      ok: true,
      agent: agentBindingOps.unarchive(
        deps.db,
        AgentIdSchema.parse(c.req.param("id")),
        UnarchiveAgentSchema.parse(await c.req.json()).expected_revision,
        c.get("authority"),
        idempotencyFrom(c),
      ),
    }),
  );
  app.post("/agents/:id/bind", async (c) => {
    const id = AgentIdSchema.parse(c.req.param("id"));
    const authority = c.get("authority");
    agentBindingOps.attach(
      deps.db,
      id,
      AttachAgentBindingSchema.parse(await c.req.json()),
      authority,
    );
    return c.json({
      ok: true,
      binding: agentBindingOps.view(deps.db, id, authority).binding,
    });
  });
  app.post("/agents/:id/release", async (c) => {
    const input = z
      .object({ expected_epoch: z.number().int().positive() })
      .strict()
      .parse(await c.req.json());
    agentBindingOps.release(
      deps.db,
      AgentIdSchema.parse(c.req.param("id")),
      input.expected_epoch,
      c.get("authority"),
    );
    return c.json({ ok: true });
  });
  // These routes have no public Worker mapping. Only derived authority travels
  // over the internal DO binding; caller-supplied headers are never forwarded.
  app.post("/agents/:id/authorize-run", (c) => {
    agentBindingOps.authorizeRun(
      deps.db,
      AgentIdSchema.parse(c.req.param("id")),
      c.get("authority").principal_id,
    );
    return c.json({ ok: true });
  });
  app.get("/agents/:id/current-run", (c) => {
    const id = AgentIdSchema.parse(c.req.param("id"));
    agentBindingOps.authorizeRun(deps.db, id, c.get("authority").principal_id);
    return c.json({
      ok: true,
      run_id: agentBindingOps.current(deps.db, id)?.holder.run_id ?? null,
    });
  });
  app.get("/agents/internal/runtime-page", (c) => {
    const input = z
      .object({
        after: AgentIdSchema.optional(),
        agent: AgentIdSchema.optional(),
        limit: z.coerce.number().int().min(1).max(RUNTIME_VIEW_MAX_LIMIT),
      })
      .strict()
      .parse(c.req.query());
    return c.json({
      ok: true,
      ...agentBindingOps.runtimePage(deps.db, c.get("authority"), input),
    });
  });
  app.post("/agents/internal/expire", async (c) => {
    if (!c.get("authority").can_manage)
      return jsonError(
        c,
        403,
        "permission-denied",
        "Revocation authority is required",
      );
    const input = z
      .object({
        run_id: z.string().uuid().optional(),
        enrollment_id: z.string().uuid().optional(),
        workload_binding_id: z.string().uuid().optional(),
        principal_id: z.string().min(1).optional(),
      })
      .strict()
      .parse(await c.req.json());
    agentBindingOps.expire(deps.db, input);
    return c.json({ ok: true });
  });
  return app;
}
