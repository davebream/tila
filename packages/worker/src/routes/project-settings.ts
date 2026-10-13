import { UpdateProjectSettingsSchema } from "@tila/schemas";
import { Hono } from "hono";
import { D1ProjectRegistry } from "../d1/project-registry";
import { zodValidationError } from "../lib/validation";
import { requirePermission } from "../middleware/permission";
import { requireFreshAuthentication } from "../middleware/protected-operation";
import { principalIdFor } from "../middleware/request-identity";
import { requireProjectOwnerHttp } from "../middleware/require-project-owner";
import type { Env, HonoVariables } from "../types";

/**
 * Settings › General (#298): the project display name. Readable by project
 * members; renaming needs explicit ownership (`project:configure` for scoped
 * credentials) and the reviewed `expected_revision`. Display only: IDs,
 * creation provenance, routing and memberships never change.
 */
export const projectSettings = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();

const notFound = {
  ok: false,
  error: { code: "not-found", message: "Project not found", retryable: false },
} as const;

projectSettings.get("/", requirePermission("read"), async (c) => {
  const settings = await new D1ProjectRegistry(c.env.DB).settings(
    c.get("projectId"),
  );
  return settings ? c.json({ ok: true, settings }) : c.json(notFound, 404);
});

projectSettings.patch("/", async (c) => {
  const denied =
    (await requireProjectOwnerHttp(c)) ?? requireFreshAuthentication(c);
  if (denied) return denied;
  const parsed = UpdateProjectSettingsSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const result = await new D1ProjectRegistry(c.env.DB).rename({
    projectId: c.get("projectId"),
    expectedRevision: parsed.data.expected_revision,
    displayName: parsed.data.display_name,
    actorPrincipalId: principalIdFor(c.get("tokenResult")),
  });
  if (result.status === "not-found") return c.json(notFound, 404);
  if (result.status === "conflict")
    return c.json(
      {
        ok: false,
        error: {
          code: "revision-conflict",
          message: `Project settings changed; current revision is ${result.revision}`,
          retryable: false,
          revision: result.revision,
          resource: `project:${c.get("projectId")}`,
        },
      },
      412,
    );
  return c.json({ ok: true, settings: result.settings });
});
