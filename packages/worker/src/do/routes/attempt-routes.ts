import {
  CredentialPolicyDenied,
  assertTaskAccess,
  attemptOps,
  attemptRecoveryOps,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
import {
  AttemptAuthorityCommandSchema,
  AttemptFinishCommandSchema,
  AttemptForceCommandSchema,
  AttemptListQuerySchema,
  AttemptRebindCommandSchema,
  AttemptReconcileCommandSchema,
  AttemptReplaceSessionCommandSchema,
  AttemptResumeCommandSchema,
  AttemptRetryCommandSchema,
  AttemptStartedCommandSchema,
  AttemptSuspendCommandSchema,
  QueueRevisionCommandSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { originFromBody } from "./origin";
import { QueueEnvelopeSchema } from "./queue-routes";
import { jsonError } from "./responses";
import type { RouterDeps } from "./types";

export function createAttemptRoutes(deps: RouterDeps) {
  const app = new Hono();
  app.post("/attempts/:action", async (c) => {
    const envelope = QueueEnvelopeSchema.parse(await c.req.json());
    const origin = originFromBody(envelope);
    const credential = readCredentialPolicy(
      c.req.header("X-Tila-Credential-Policy"),
    );
    const action = c.req.param("action");
    const read = action === "get" || action === "list";
    const required = read
      ? ["tasks:read", "claims:read"]
      : action === "rebind" || action === "force-recovery"
        ? ["tasks:write", "claims:acquire", "schema:write"]
        : ["tasks:write", "claims:renew"];
    if (
      (!read &&
        (envelope.authorized_role === "viewer" ||
          credential?.role === "viewer")) ||
      (credential &&
        required.some(
          (cap) => !(credential.capabilities as string[]).includes(cap),
        ))
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
    const manage =
      ["maintainer", "owner"].includes(envelope.authorized_role) &&
      (!credential || ["maintainer", "owner"].includes(credential.role));
    const body = envelope.command;
    if (action === "list")
      return c.json({
        ok: true,
        result: attemptOps.list(
          deps.db,
          AttemptListQuerySchema.parse(body),
          allowsTask,
        ),
      });
    const id = z.string().min(1).parse(envelope.id);
    if (!allowsTask(attemptOps.get(deps.db, id).task_id))
      throw new CredentialPolicyDenied();
    const result = (() => {
      switch (action) {
        case "get":
          return attemptOps.view(deps.db, id, origin);
        case "accept":
          return attemptOps.accept(
            deps.db,
            id,
            AttemptAuthorityCommandSchema.parse(body),
            origin,
          );
        case "started":
          return attemptOps.started(
            deps.db,
            id,
            AttemptStartedCommandSchema.parse(body),
            origin,
          );
        case "heartbeat":
          return attemptOps.heartbeat(
            deps.db,
            id,
            AttemptAuthorityCommandSchema.parse(body),
            origin,
          );
        case "finish":
          return attemptOps.finish(
            deps.db,
            id,
            AttemptFinishCommandSchema.parse(body),
            origin,
          );
        case "request-cancellation":
          return attemptRecoveryOps.requestCancellation(
            deps.db,
            id,
            QueueRevisionCommandSchema.parse(body),
            origin,
            manage,
          );
        case "request-suspension":
          return attemptRecoveryOps.requestSuspension(
            deps.db,
            id,
            QueueRevisionCommandSchema.parse(body),
            origin,
            manage,
          );
        case "confirm-suspension":
          return attemptRecoveryOps.confirmSuspension(
            deps.db,
            id,
            AttemptSuspendCommandSchema.parse(body),
            origin,
          );
        case "request-resume":
          return attemptRecoveryOps.requestResume(
            deps.db,
            id,
            QueueRevisionCommandSchema.parse(body),
            origin,
            manage,
          );
        case "claim-resume":
          return attemptRecoveryOps.claimResume(
            deps.db,
            id,
            AttemptResumeCommandSchema.parse(body),
            origin,
          );
        case "reconcile":
          return attemptRecoveryOps.reconcile(
            deps.db,
            id,
            AttemptReconcileCommandSchema.parse(body),
            origin,
            manage,
          );
        case "rebind":
          return attemptRecoveryOps.rebind(
            deps.db,
            id,
            AttemptRebindCommandSchema.parse(body),
            origin,
            manage,
          );
        case "retry":
          return attemptRecoveryOps.retry(
            deps.db,
            id,
            AttemptRetryCommandSchema.parse(body),
            origin,
            manage,
          );
        case "replace-session":
          return attemptRecoveryOps.replaceSession(
            deps.db,
            id,
            AttemptReplaceSessionCommandSchema.parse(body),
            origin,
          );
        case "force-recovery":
          return attemptRecoveryOps.forceRecovery(
            deps.db,
            id,
            AttemptForceCommandSchema.parse(body),
            origin,
            manage,
          );
        default:
          return undefined;
      }
    })();
    return result === undefined
      ? jsonError(c, 404, "not-found", "Unknown attempt operation")
      : c.json({ ok: true, result });
  });
  return app;
}
