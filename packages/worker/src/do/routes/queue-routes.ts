import {
  CredentialPolicyDenied,
  assertTaskAccess,
  queueOps,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
import {
  EnvironmentMetadataSchema,
  ParticipantIdSchema,
  QueueClaimCommandSchema,
  QueueConfigureCommandSchema,
  QueueEditCommandSchema,
  QueueEnrollCommandSchema,
  QueueListQuerySchema,
  QueueRevisionCommandSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { originFromBody } from "./origin";
import { jsonError } from "./responses";
import type { RouterDeps } from "./types";

const EnvelopeSchema = z.object({
  principal_id: z.string().min(1),
  participant_id: ParticipantIdSchema,
  environment: EnvironmentMetadataSchema.default({}),
  actor_token_id: z.string().nullable().optional(),
  authorized_role: z
    .enum(["viewer", "participant", "maintainer", "owner"])
    .default("participant"),
  id: z.string().optional(),
  command: z.record(z.string(), z.unknown()).default({}),
});
/** Internal-only transport. Worker supplies canonical identity and effective role in B3. */
export function createQueueRoutes(deps: RouterDeps) {
  const app = new Hono();
  app.post("/queue/:action", async (c) => {
    const envelope = EnvelopeSchema.parse(await c.req.json());
    const origin = originFromBody(envelope);
    const credential = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    );
    const action = c.req.param("action");
    if (
      action !== "policy" &&
      action !== "inspect" &&
      (envelope.authorized_role === "viewer" || credential?.role === "viewer")
    )
      throw new CredentialPolicyDenied();
    const required =
      action === "configure"
        ? ["schema:write"]
        : action === "policy" || action === "inspect"
          ? ["tasks:read", "claims:read"]
          : action === "claim"
            ? ["tasks:read", "tasks:write", "claims:acquire"]
            : ["tasks:write"];
    if (
      credential &&
      required.some(
        (cap) => !(credential.capabilities as string[]).includes(cap),
      )
    )
      throw new CredentialPolicyDenied();
    const allowsTask = (id: string) => {
      if (!credential) return true;
      try {
        assertTaskAccess(deps.db, credential, id);
        return true;
      } catch (error) {
        if (error instanceof CredentialPolicyDenied) return false;
        throw error;
      }
    };
    const requireTask = (id: string) => {
      if (!allowsTask(id)) throw new CredentialPolicyDenied();
    };
    const manage =
      ["maintainer", "owner"].includes(envelope.authorized_role) &&
      (!credential || ["maintainer", "owner"].includes(credential.role));
    const body = envelope.command;
    switch (action) {
      case "policy":
        return c.json({ ok: true, result: queueOps.policy(deps.db) });
      case "configure":
        return c.json({
          ok: true,
          result: queueOps.configure(
            deps.db,
            QueueConfigureCommandSchema.parse(body),
            origin,
            manage,
          ),
        });
      case "inspect":
        return c.json({
          ok: true,
          result: queueOps.inspect(
            deps.db,
            QueueListQuerySchema.parse(body),
            allowsTask,
          ),
        });
      case "enroll": {
        const input = QueueEnrollCommandSchema.parse(body);
        requireTask(input.task_id);
        return c.json({
          ok: true,
          result: queueOps.enroll(deps.db, input, origin),
        });
      }
      case "edit":
      case "withdraw": {
        const id = z.string().min(1).parse(envelope.id);
        requireTask(queueOps.getEntry(deps.db, id).task_id);
        return c.json({
          ok: true,
          result:
            action === "edit"
              ? queueOps.edit(
                  deps.db,
                  id,
                  QueueEditCommandSchema.parse(body),
                  origin,
                )
              : queueOps.withdraw(
                  deps.db,
                  id,
                  QueueRevisionCommandSchema.parse(body),
                  origin,
                ),
        });
      }
      case "claim":
        return c.json({
          ok: true,
          result: queueOps.claimNext(
            deps.db,
            QueueClaimCommandSchema.parse(body),
            origin,
            allowsTask,
          ),
        });
      default:
        return jsonError(c, 404, "not-found", "Unknown queue operation");
    }
  });
  return app;
}
