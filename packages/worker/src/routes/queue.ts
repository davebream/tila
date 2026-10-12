import {
  AttemptListQuerySchema,
  AttemptMutationSchemas,
  PROJECT_ROLE_RANK,
  QueueListQuerySchema,
  QueueMutationSchemas,
} from "@tila/schemas";
import { type Context, Hono } from "hono";
import { ProjectMembershipStore } from "../d1";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import { identityPayload } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };
function envelope(c: Context<AppEnv>, command: unknown, id?: string) {
  return {
    ...(c.req.method === "GET" && !c.get("participantId")
      ? {
          principal_id: c.get("principalId"),
          participant_id: "queue-read-only",
          environment: {},
          actor_token_id: null,
        }
      : identityPayload(c)),
    authorized_role: c.get("effectiveRole") ?? "viewer",
    command,
    id,
  };
}
async function forward(
  c: Context<AppEnv>,
  family: "queue" | "attempts",
  action: string,
  command: unknown,
  id?: string,
) {
  c.header("Cache-Control", "private, no-store");
  const response = await forwardToDO(
    c.get("doStub"),
    `/${family}/${action}`,
    "POST",
    envelope(c, command, id),
    undefined,
    analyticsCtxFrom(c),
  );
  // Inspection without a worker identity never constitutes execution authority,
  // even if a worker happens to use the internal read-only participant label.
  if (
    response.ok &&
    family === "attempts" &&
    action === "get" &&
    !c.get("participantId")
  ) {
    const body = (await response.json()) as {
      result: { grant_valid: boolean };
    };
    body.result.grant_valid = false;
    return new Response(JSON.stringify(body), response);
  }
  return response;
}
function query(c: Context<AppEnv>) {
  const result: Record<string, unknown> = { ...c.req.query() };
  for (const key of ["limit", "offset", "priority"])
    if (result[key] !== undefined) result[key] = Number(result[key]);
  if (typeof result.capabilities === "string") {
    try {
      result.capabilities = JSON.parse(result.capabilities);
    } catch {
      /* schema produces the validation error */
    }
  }
  return result;
}
function keyConflict(c: Context<AppEnv>, body: { idempotency_key: string }) {
  const header = c.req.header("Idempotency-Key");
  if (header && header !== body.idempotency_key)
    return c.json(
      {
        ok: false,
        error: {
          code: "queue-idempotency-conflict",
          message: "Header and command idempotency keys must match",
          retryable: false,
        },
      },
      409,
    );
  return null;
}
export const queueRoutes = new Hono<AppEnv>();
queueRoutes.get("/", requirePermission("read"), (c) => {
  const parsed = QueueListQuerySchema.safeParse(query(c));
  return parsed.success
    ? forward(c, "queue", "inspect", parsed.data)
    : zodValidationError(c, parsed.error);
});
queueRoutes.get("/policy", requirePermission("read"), (c) =>
  forward(c, "queue", "policy", {}),
);
for (const [action, schema] of Object.entries(QueueMutationSchemas)) {
  const path =
    action === "edit" || action === "withdraw"
      ? `/entries/:id/${action}`
      : `/${action}`;
  queueRoutes.post(
    path,
    requirePermission(action === "configure" ? "admin" : "write"),
    async (c) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return zodValidationError(c, parsed.error);
      const conflict = keyConflict(c, parsed.data);
      if (conflict) return conflict;
      return forward(c, "queue", action, parsed.data, c.req.param("id"));
    },
  );
}
export const attemptRoutes = new Hono<AppEnv>();
attemptRoutes.get("/", requirePermission("read"), (c) => {
  const parsed = AttemptListQuerySchema.safeParse(query(c));
  return parsed.success
    ? forward(c, "attempts", "list", parsed.data)
    : zodValidationError(c, parsed.error);
});
attemptRoutes.get("/:id", requirePermission("read"), (c) =>
  forward(c, "attempts", "get", {}, c.req.param("id")),
);
for (const [action, schema] of Object.entries(AttemptMutationSchemas)) {
  attemptRoutes.post(
    `/:id/${action}`,
    requirePermission(
      action === "rebind" || action === "force-recovery" ? "admin" : "write",
    ),
    async (c) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return zodValidationError(c, parsed.error);
      const conflict = keyConflict(c, parsed.data);
      if (conflict) return conflict;
      if (
        action === "rebind" &&
        "principal_id" in parsed.data &&
        typeof parsed.data.principal_id === "string" &&
        parsed.data.principal_id !== c.get("principalId")
      ) {
        const membership = await new ProjectMembershipStore(c.env.DB).resolve(
          c.get("projectId"),
          parsed.data.principal_id,
        );
        if (
          !membership ||
          PROJECT_ROLE_RANK[membership.role] < PROJECT_ROLE_RANK.participant
        )
          return c.json(
            {
              ok: false,
              error: {
                code: "permission-denied",
                message:
                  "Replacement principal must have current participant membership",
                retryable: false,
              },
            },
            403,
          );
      }
      return forward(c, "attempts", action, parsed.data, c.req.param("id"));
    },
  );
}
