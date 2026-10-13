import {
  CredentialPolicyDenied,
  JournalReportError,
  customJournalOps,
  projectTransferOps,
  readCredentialPolicy,
} from "@tila/ops-sqlite";
import {
  IdentityContextSchema,
  JournalAppendRequestSchema,
  JournalIdempotencyKeySchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { z } from "zod";
import { createR2JournalArchiveReader } from "../../r2";
import { originFromBody } from "./origin";
import type { RouterDeps } from "./types";

const Envelope = IdentityContextSchema.extend({
  actor_token_id: z.string().nullable(),
  project_id: z.string().min(1),
  authorized_role: z.enum(["viewer", "participant", "maintainer", "owner"]),
  input: JournalAppendRequestSchema,
  idempotency_key: JournalIdempotencyKeySchema,
});

export function createCustomJournalRoutes(deps: RouterDeps) {
  const app = new Hono();
  app.post("/journal/append", async (c) => {
    const envelope = Envelope.parse(await c.req.json());
    if (envelope.authorized_role === "viewer")
      throw new CredentialPolicyDenied();
    const { response, replayed } = await customJournalOps.appendReport(
      deps.db,
      {
        projectId: envelope.project_id,
        origin: originFromBody(envelope),
        input: envelope.input,
        idempotencyKey: envelope.idempotency_key,
        policy: readCredentialPolicy(c.req.header("X-Tila-Credential-Policy")),
        archives: deps.artifacts
          ? createR2JournalArchiveReader(deps.artifacts, envelope.project_id)
          : undefined,
        assertWritable: () => {
          if (projectTransferOps.getTransferState(deps.ctx.storage.sql))
            throw new JournalReportError(
              "project-maintenance",
              "Project is locked for transfer",
              423,
            );
        },
      },
    );
    if (replayed) c.header("Idempotency-Replayed", "true");
    c.header("Cache-Control", "private, no-store");
    return c.json(response);
  });
  return app;
}
