import { RuntimeDenied, RuntimeStore } from "@tila/backend-d1";
import {
  AgentIdSchema,
  AgentRegistrationSchema,
  AttachAgentBindingSchema,
  PROJECT_ROLE_RANK,
} from "@tila/schemas";
import { Hono } from "hono";
import { runtimeIdentity } from "../lib/agent-authority";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { principalIdFor } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";

export const agents = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
agents.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});
agents.all("*", async (c) => {
  const relative = c.req.path
    .replace(/^\/projects\/[^/]+/, "")
    .replace(/\/$/, "");
  const match = relative.match(/^\/agents(?:\/([^/]+)(?:\/(bind|release))?)?$/);
  if (!match) return c.notFound();
  const id = match[1];
  const action = match[2];
  if (id && !AgentIdSchema.safeParse(id).success)
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "Invalid agent ID",
          retryable: false,
        },
      },
      400,
    );
  const token = c.get("tokenResult");
  const policy = c.get("credentialPolicy");
  const role = c.get("effectiveRole");
  const authority = {
    principal_id: principalIdFor(token),
    can_manage: policy
      ? policy.capabilities.includes("agents:manage")
      : (token.kind === "d1-token" && token.scopes === "full") ||
        (role !== undefined &&
          PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK.maintainer),
    runtime: runtimeIdentity(
      token.kind === "d1-token" ? token.runtime : undefined,
    ),
    acting_runtime: null as ReturnType<typeof runtimeIdentity>,
    terminal_run_id: null as string | null,
  };
  const headers = () => ({
    "X-Tila-Agent-Authority": JSON.stringify(authority),
  });
  let body: unknown;
  if (c.req.method === "POST") {
    const raw = await c.req.json().catch(() => null);
    if (!id) {
      const parsed = AgentRegistrationSchema.safeParse(raw);
      if (!parsed.success) return zodValidationError(c, parsed.error);
      body = parsed.data;
    } else if (action === "bind") {
      const parsed = AttachAgentBindingSchema.safeParse(raw);
      if (!parsed.success) return zodValidationError(c, parsed.error);
      if (!authority.runtime || authority.runtime.agent_id !== id)
        return c.json(
          {
            ok: false,
            error: {
              code: "runtime-required",
              message: "Start a run pinned to this agent",
              retryable: false,
            },
          },
          403,
        );
      const store = new RuntimeStore(c.env.DB);
      if (authority.runtime.run_role === "relay") {
        const acting = parsed.data.acting_run_id
          ? await store.run(parsed.data.acting_run_id)
          : undefined;
        if (
          !acting ||
          acting.project_id !== c.get("projectId") ||
          acting.enrollment_id !== authority.runtime.enrollment_id
        )
          return c.json(
            {
              ok: false,
              error: {
                code: "permission-denied",
                message: "Acting run must belong to this enrollment",
                retryable: false,
              },
            },
            403,
          );
        authority.acting_runtime = runtimeIdentity(
          await store.context(acting.current_token_id),
        );
      }
      const active = await forwardToDO(
        c.get("doStub"),
        `/agents/${id}/current-run`,
        "GET",
        undefined,
        undefined,
        undefined,
        headers(),
      );
      if (!active.ok) return active;
      const { run_id } = (await active.json()) as { run_id: string | null };
      if (run_id) {
        const previous = await store.run(run_id);
        if (
          previous &&
          previous.project_id === c.get("projectId") &&
          (previous.state !== "active" ||
            previous.lease_expires_at <= Math.floor(Date.now() / 1000))
        )
          authority.terminal_run_id = run_id;
      }
      body = parsed.data;
    } else if (action === "release") body = raw;
    else return c.notFound();
  } else if (c.req.method !== "GET" || action) return c.notFound();
  const response = await forwardToDO(
    c.get("doStub"),
    relative,
    c.req.method,
    body,
    undefined,
    analyticsCtxFrom(c),
    headers(),
  );
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "private, no-store");
  return result;
});

agents.onError((error, c) => {
  if (error instanceof RuntimeDenied)
    return c.json(
      {
        ok: false,
        error: { code: error.code, message: error.message, retryable: false },
      },
      403,
    );
  throw error;
});
