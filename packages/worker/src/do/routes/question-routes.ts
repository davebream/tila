import {
  CredentialPolicyDenied,
  assertTaskAccess,
  attemptOps,
  conversationOps,
  questionOps,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
import { QuestionRequestSchema, RuntimeIdentitySchema } from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { originFromBody } from "./origin";
import { QueueEnvelopeSchema } from "./queue-routes";
import type { RouterDeps } from "./types";

const Envelope = QueueEnvelopeSchema.extend({
  runtime: RuntimeIdentitySchema.nullable(),
  target_authorized: z.boolean().default(false),
});
export function createQuestionRoutes(deps: RouterDeps) {
  const app = new Hono();
  app.post("/questions/:action", async (c) => {
    const envelope = Envelope.parse(await c.req.json());
    const action = c.req.param("action");
    const request = QuestionRequestSchema.parse({
      action,
      id: envelope.id,
      command: envelope.command,
      query: envelope.command,
    });
    const read = action === "get" || action === "list";
    const credential = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    );
    const origin = originFromBody(envelope);
    const role = envelope.authorized_role;
    const has = (cap: string) =>
      !credential || (credential.capabilities as string[]).includes(cap);
    if (
      !has(read ? "tasks:read" : "tasks:write") ||
      (!read && (role === "viewer" || credential?.role === "viewer")) ||
      (action === "ask" && !has("claims:renew"))
    )
      throw new CredentialPolicyDenied();
    const authority: questionOps.QuestionAuthority = {
      origin,
      can_manage:
        ["owner", "maintainer"].includes(role) &&
        (!credential || ["owner", "maintainer"].includes(credential.role)),
      is_owner:
        role === "owner" && (!credential || credential.role === "owner"),
      conversation: {
        principal_id: origin.principalId,
        participant_id: origin.participantId,
        can_manage:
          has("conversations:manage") && ["owner", "maintainer"].includes(role),
        runtime: envelope.runtime,
      },
    };
    if (envelope.runtime)
      conversationOps.activeBinding(
        deps.db,
        envelope.runtime.agent_id ?? "",
        authority.conversation,
        Date.now(),
      );
    const allowsTask = (id: string) => {
      if (!credential) return true;
      try {
        assertTaskAccess(deps.db, credential, id);
        return true;
      } catch (e) {
        if (e instanceof CredentialPolicyDenied) return false;
        throw e;
      }
    };
    if (request.action === "list")
      return c.json({
        ok: true,
        result: questionOps.list(deps.db, request.query, authority, allowsTask),
      });
    const task =
      request.action === "ask"
        ? attemptOps.get(deps.db, request.command.attempt_id).task_id
        : questionOps.get(deps.db, request.id).task_id;
    if (!allowsTask(task)) throw new CredentialPolicyDenied();
    if (
      (request.action === "ask" || request.action === "escalate") &&
      !envelope.target_authorized
    )
      throw new CredentialPolicyDenied();
    if (
      (request.action === "link-discussion" ||
        (request.action === "ask" && request.command.discussion.length > 0)) &&
      !has("conversations:read")
    )
      throw new CredentialPolicyDenied();
    const result = (() => {
      switch (request.action) {
        case "get":
          return questionOps.view(deps.db, request.id, authority);
        case "ask":
          return questionOps.ask(deps.db, request.command, authority);
        case "answer":
          return questionOps.answer(
            deps.db,
            request.id,
            request.command,
            authority,
          );
        case "escalate":
          return questionOps.escalate(
            deps.db,
            request.id,
            request.command,
            authority,
          );
        case "cancel":
          return questionOps.cancel(
            deps.db,
            request.id,
            request.command,
            authority,
          );
        case "link-discussion":
          return questionOps.linkDiscussion(
            deps.db,
            request.id,
            request.command,
            authority,
          );
      }
    })();
    return c.json({ ok: true, result });
  });
  return app;
}
