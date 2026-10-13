import {
  PROJECT_ROLE_RANK,
  QuestionListQuerySchema,
  QuestionMutationSchemas,
} from "@tila/schemas";
import { type Context, Hono } from "hono";
import { ProjectMembershipStore } from "../d1";
import { runtimeIdentity } from "../lib/agent-authority";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import {
  identityPayload,
  principalIdFor,
} from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };
async function forward(
  c: Context<AppEnv>,
  action: string,
  command: unknown,
  id?: string,
  target = false,
) {
  const token = c.get("tokenResult");
  c.header("Cache-Control", "private, no-store");
  let role = c.get("effectiveRole") ?? "viewer";
  if (action === "answer") {
    const membership = await new ProjectMembershipStore(c.env.DB).resolve(
      c.get("projectId"),
      principalIdFor(token),
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
            message: "Responder requires current project membership",
            retryable: false,
          },
        },
        403,
      );
    if (PROJECT_ROLE_RANK[membership.role] < PROJECT_ROLE_RANK[role])
      role = membership.role;
  }
  const response = await forwardToDO(
    c.get("doStub"),
    `/questions/${action}`,
    "POST",
    {
      ...(c.req.method === "GET" && !c.get("participantId")
        ? {
            principal_id: principalIdFor(token),
            participant_id: "question-read-only",
            environment: {},
            actor_token_id: null,
          }
        : identityPayload(c)),
      authorized_role: role,
      runtime: runtimeIdentity(
        token.kind === "d1-token" ? token.runtime : undefined,
      ),
      target_authorized: target,
      command,
      id,
    },
    undefined,
    analyticsCtxFrom(c),
  );
  if (
    response.ok &&
    (action === "get" || action === "list") &&
    !c.get("participantId")
  ) {
    const body = (await response.json()) as {
      result: {
        answer_applicable?: boolean;
        questions?: { answer_applicable: boolean }[];
      };
    };
    if (action === "get") body.result.answer_applicable = false;
    else
      for (const item of body.result.questions ?? [])
        item.answer_applicable = false;
    return new Response(JSON.stringify(body), response);
  }
  return response;
}
export const questionRoutes = new Hono<AppEnv>();
questionRoutes.get("/", requirePermission("read"), (c) => {
  const raw = c.req.query();
  const parsed = QuestionListQuerySchema.safeParse({
    ...raw,
    ...(raw.limit ? { limit: Number(raw.limit) } : {}),
    // Any other value reaches the schema, which rejects it.
    ...(raw.escalated === "true" || raw.escalated === "false"
      ? { escalated: raw.escalated === "true" }
      : {}),
  });
  return parsed.success
    ? forward(c, "list", parsed.data)
    : zodValidationError(c, parsed.error);
});
questionRoutes.get("/:id", requirePermission("read"), (c) =>
  forward(c, "get", {}, c.req.param("id")),
);
for (const [action, schema] of Object.entries(QuestionMutationSchemas)) {
  questionRoutes.post(
    action === "ask" ? "/" : `/:id/${action}`,
    requirePermission("write"),
    async (c) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return zodValidationError(c, parsed.error);
      const header = c.req.header("Idempotency-Key");
      if (header && header !== parsed.data.idempotency_key)
        return c.json(
          {
            ok: false,
            error: {
              code: "question-idempotency-conflict",
              message: "Header and command keys must match",
              retryable: false,
            },
          },
          409,
        );
      let target = false;
      if (
        (action === "ask" || action === "escalate") &&
        "responder_principal_id" in parsed.data
      ) {
        const membership = await new ProjectMembershipStore(c.env.DB).resolve(
          c.get("projectId"),
          parsed.data.responder_principal_id,
        );
        target =
          !!membership &&
          (action === "escalate"
            ? membership.role === "owner"
            : PROJECT_ROLE_RANK[membership.role] >=
              PROJECT_ROLE_RANK.participant);
        if (!target)
          return c.json(
            {
              ok: false,
              error: {
                code: "permission-denied",
                message:
                  action === "escalate"
                    ? "Escalation requires a current project owner"
                    : "Responder requires current participant membership",
                retryable: false,
              },
            },
            403,
          );
      }
      return forward(c, action, parsed.data, c.req.param("id"), target);
    },
  );
}
