import {
  CredentialConflict,
  CredentialDenied,
  CredentialStore,
} from "@tila/backend-d1";
import {
  PROJECT_ROLE_RANK,
  ServiceAccountCreateRequestSchema,
  ServiceAccountUpdateRequestSchema,
  WorkloadBindingRequestSchema,
  WorkloadBindingUpdateRequestSchema,
  policyContains,
} from "@tila/schemas";
import { Hono } from "hono";
import { expireAgentBindings } from "../lib/agent-authority";
import { zodValidationError } from "../lib/validation";
import { denied, scopedPolicy } from "../middleware/capability";
import { stepUpGuard } from "../middleware/protected-operation";
import { principalIdFor } from "../middleware/request-identity";
import { requireProjectOwner } from "../middleware/require-project-owner";
import type { Env, HonoVariables } from "../types";

export const serviceAccountRoutes = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();
serviceAccountRoutes.use("*", requireProjectOwner, stepUpGuard);
serviceAccountRoutes.get("/", async (c) =>
  c.json({
    ok: true,
    service_accounts: await new CredentialStore(c.env.DB).listServices(
      c.get("projectId"),
    ),
  }),
);
serviceAccountRoutes.post("/", async (c) => {
  const parsed = ServiceAccountCreateRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const policy = scopedPolicy(c);
  if (
    policy &&
    PROJECT_ROLE_RANK[parsed.data.role] > PROJECT_ROLE_RANK[policy.role]
  )
    return denied(c);
  const token = c.get("tokenResult");
  const account = await new CredentialStore(c.env.DB).createService(
    c.get("projectId"),
    parsed.data,
    { principalId: principalIdFor(token), tokenId: token.tokenId },
  );
  return c.json({ ok: true, service_account: account }, 201);
});
serviceAccountRoutes.patch("/:principalId", async (c) => {
  const parsed = ServiceAccountUpdateRequestSchema.safeParse(
    await c.req.json(),
  );
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const token = c.get("tokenResult");
  const account = await new CredentialStore(c.env.DB).updateService(
    c.get("projectId"),
    c.req.param("principalId"),
    parsed.data.display_name,
    { principalId: principalIdFor(token), tokenId: token.tokenId },
  );
  return c.json(
    { ok: !!account, service_account: account },
    account ? 200 : 404,
  );
});
serviceAccountRoutes.delete("/:principalId", async (c) => {
  const token = c.get("tokenResult");
  await new CredentialStore(c.env.DB).revokeService(
    c.get("projectId"),
    c.req.param("principalId"),
    { principalId: principalIdFor(token), tokenId: token.tokenId },
  );
  await expireAgentBindings(c.env, c.get("projectId"), {
    principal_id: c.req.param("principalId"),
  });
  return c.json({ ok: true });
});
serviceAccountRoutes.get("/:principalId/workload-bindings", async (c) =>
  c.json({
    ok: true,
    bindings: await new CredentialStore(c.env.DB).listBindings(
      c.get("projectId"),
      c.req.param("principalId"),
    ),
  }),
);
serviceAccountRoutes.post("/:principalId/workload-bindings", async (c) => {
  const parsed = WorkloadBindingRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const policy = scopedPolicy(c);
  if (policy && !policyContains(policy, parsed.data.policy)) return denied(c);
  const token = c.get("tokenResult");
  const binding = await new CredentialStore(c.env.DB).createBinding(
    c.get("projectId"),
    c.req.param("principalId"),
    parsed.data,
    { principalId: principalIdFor(token), tokenId: token.tokenId },
  );
  return c.json({ ok: true, binding }, 201);
});
serviceAccountRoutes.patch(
  "/:principalId/workload-bindings/:bindingId",
  async (c) => {
    const parsed = WorkloadBindingUpdateRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) return zodValidationError(c, parsed.error);
    const policy = scopedPolicy(c);
    if (policy && !policyContains(policy, parsed.data.policy)) return denied(c);
    const token = c.get("tokenResult");
    const binding = await new CredentialStore(c.env.DB).updateBinding(
      c.get("projectId"),
      c.req.param("principalId"),
      c.req.param("bindingId"),
      parsed.data.policy,
      { principalId: principalIdFor(token), tokenId: token.tokenId },
    );
    return c.json({ ok: !!binding, binding }, binding ? 200 : 404);
  },
);
serviceAccountRoutes.delete(
  "/:principalId/workload-bindings/:bindingId",
  async (c) => {
    const token = c.get("tokenResult");
    const revoked = await new CredentialStore(c.env.DB).revokeBinding(
      c.get("projectId"),
      c.req.param("principalId"),
      c.req.param("bindingId"),
      { principalId: principalIdFor(token), tokenId: token.tokenId },
    );
    if (revoked)
      await expireAgentBindings(c.env, c.get("projectId"), {
        workload_binding_id: c.req.param("bindingId"),
      });
    return c.json({ ok: revoked }, revoked ? 200 : 404);
  },
);
serviceAccountRoutes.onError((error, c) => {
  if (
    error instanceof CredentialConflict ||
    error.message.includes("UNIQUE constraint failed")
  )
    return c.json(
      {
        ok: false,
        error: {
          code: "credential-conflict",
          message:
            "Account or binding conflicts with current state, or is the last owner",
          retryable: false,
        },
      },
      409,
    );
  if (error instanceof CredentialDenied) return denied(c);
  throw error;
});
