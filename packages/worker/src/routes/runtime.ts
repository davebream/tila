import {
  D1DeploymentMetaStore,
  RuntimeDenied,
  RuntimeStore,
} from "@tila/backend-d1";
import {
  CREDENTIAL_PRESETS,
  CredentialPolicyReadSchema,
  RuntimeEnrollmentRequestSchema,
  RuntimeInvitationRequestSchema,
  RuntimeRedeemRequestSchema,
  RuntimeRenewRequestSchema,
  RuntimeRunRequestSchema,
  intersectCredentialPolicies,
  policyContains,
} from "@tila/schemas";
import { Hono } from "hono";
import {
  agentRunAuthorizer,
  expireAgentBindings,
} from "../lib/agent-authority";
import { hashToken } from "../lib/hash";
import {
  runtimeAuthority,
  runtimeCeiling,
  runtimeDescendant,
  runtimeOperator,
  runtimeProof,
  runtimeSecret,
  runtimeVisibleEnrollments,
} from "../lib/runtime-access";
import { zodValidationError } from "../lib/validation";
import { createAuthMiddleware } from "../middleware/auth";
import { csrfGuard } from "../middleware/csrf";
import { mirroredCandidateForToken } from "../middleware/membership";
import { principalIdFor } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };
export const runtimeRoutes = new Hono<AppEnv>();
runtimeRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
runtimeRoutes.get("/api/runtime/info", async (c) =>
  c.json({
    ok: true,
    protocol: 1,
    instance_id: await new D1DeploymentMetaStore(c.env.DB).ensure(),
  }),
);
runtimeRoutes.post("/projects/:projectId/runtime/redeem", async (c) => {
  const parsed = RuntimeRedeemRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const { invitation, ...input } = parsed.data;
  const store = new RuntimeStore(c.env.DB);
  const hash = await hashToken(invitation, c.env.HASH_PEPPER);
  const invite = await store.invitation(hash);
  if (!invite || invite.project_id !== c.req.param("projectId"))
    throw new RuntimeDenied("invitation-invalid", "Invalid invitation");
  await runtimeProof(c, input.jkt, invitation);
  const { token, secret } = await runtimeSecret(c);
  const context = await store.enroll(
    invite.project_id,
    input,
    null,
    CredentialPolicyReadSchema.parse(JSON.parse(invite.policy_json)),
    secret,
    hash,
  );
  return c.json({ ok: true, token, context });
});
runtimeRoutes.use("/api/runtime/*", createAuthMiddleware(), csrfGuard);
runtimeRoutes.use(
  "/projects/:projectId/runtime/*",
  createAuthMiddleware(),
  csrfGuard,
);
runtimeRoutes.get("/api/runtime/context", (c) => {
  const context = runtimeAuthority(c);
  if (!context)
    throw new RuntimeDenied(
      "runtime-purpose-denied",
      "A runtime credential is required",
    );
  return c.json(context);
});
runtimeRoutes.use("/projects/:projectId/runtime/*", async (c, next) => {
  const project = c.req.param("projectId");
  if (c.get("tokenResult").projectId !== project)
    throw new RuntimeDenied(
      "runtime-binding-mismatch",
      "Credential belongs to another project",
    );
  c.set("projectId", project);
  await next();
});
runtimeRoutes.post("/projects/:projectId/runtime/enrollments", async (c) => {
  const denied = await runtimeOperator(c);
  if (denied) return denied;
  const parsed = RuntimeEnrollmentRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodValidationError(c, parsed.error);
  if (
    parsed.data.policy &&
    !policyContains(CREDENTIAL_PRESETS.worker, parsed.data.policy)
  ) {
    const ownerDenied = await runtimeOperator(c, true);
    if (ownerDenied) return ownerDenied;
  }
  await runtimeProof(
    c,
    parsed.data.jkt,
    c.req.header("Authorization")?.replace(/^Bearer /i, "") ?? "",
    "X-Tila-Enrollment-Proof",
  );
  const { token, secret } = await runtimeSecret(c);
  const context = await new RuntimeStore(c.env.DB).enroll(
    c.get("projectId"),
    parsed.data,
    principalIdFor(c.get("tokenResult")),
    runtimeCeiling(c),
    secret,
    undefined,
    await mirroredCandidateForToken(c.env.DB, c.get("tokenResult")),
  );
  return c.json({ ok: true, token, context });
});
runtimeRoutes.post("/projects/:projectId/runtime/invitations", async (c) => {
  const denied = await runtimeOperator(c, true);
  if (denied) return denied;
  const parsed = RuntimeInvitationRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const policy =
    parsed.data.policy ??
    intersectCredentialPolicies(runtimeCeiling(c), CREDENTIAL_PRESETS.worker);
  if (!policyContains(runtimeCeiling(c), policy))
    throw new RuntimeDenied(
      "runtime-policy-denied",
      "Invitation exceeds caller authority",
    );
  const { token, secret } = await runtimeSecret(c);
  const expires_at = await new RuntimeStore(c.env.DB).invite(
    c.get("projectId"),
    principalIdFor(c.get("tokenResult")),
    parsed.data.name,
    policy,
    secret.hash,
  );
  return c.json({ ok: true, invitation: token, expires_at });
});
runtimeRoutes.get("/projects/:projectId/runtime/enrollments", async (c) =>
  c.json({ ok: true, enrollments: await runtimeVisibleEnrollments(c) }),
);
runtimeRoutes.post(
  "/projects/:projectId/runtime/enrollments/:enrollmentId/revoke",
  async (c) => {
    if (runtimeAuthority(c))
      throw new RuntimeDenied(
        "runtime-purpose-denied",
        "Operator authentication required",
      );
    const row = (await runtimeVisibleEnrollments(c)).find(
      (item) => item.enrollment_id === c.req.param("enrollmentId"),
    );
    if (!row)
      throw new RuntimeDenied(
        "runtime-binding-mismatch",
        "Installation is not accessible",
      );
    const denied = await runtimeOperator(
      c,
      row.sponsor_id !== principalIdFor(c.get("tokenResult")),
    );
    if (denied) return denied;
    await new RuntimeStore(c.env.DB).revokeEnrollment(
      row.enrollment_id,
      principalIdFor(c.get("tokenResult")),
    );
    await expireAgentBindings(c.env, c.get("projectId"), {
      enrollment_id: row.enrollment_id,
    });
    return c.json({ ok: true });
  },
);
runtimeRoutes.post("/projects/:projectId/runtime/runs", async (c) => {
  const authority = runtimeAuthority(c);
  if (authority?.purpose !== "enrollment" || !authority.enrollment_id)
    throw new RuntimeDenied(
      "runtime-purpose-denied",
      "An enrollment credential is required to start runs",
    );
  const parsed = RuntimeRunRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const { token, secret } = await runtimeSecret(c);
  const context = await new RuntimeStore(
    c.env.DB,
    undefined,
    agentRunAuthorizer(c.env),
  ).start(authority.enrollment_id, parsed.data, secret);
  return c.json({ ok: true, token, context });
});
runtimeRoutes.get("/projects/:projectId/runtime/runs", async (c) => {
  const enrollments = await runtimeVisibleEnrollments(c);
  const token = c.get("tokenResult");
  const owner =
    !runtimeAuthority(c) &&
    ((token.kind === "d1-token" && token.scopes === "full") ||
      c.get("effectiveRole") === "owner");
  return c.json({
    ok: true,
    runs: await new RuntimeStore(c.env.DB).listRuns(
      c.get("projectId"),
      owner ? undefined : enrollments.map((row) => row.enrollment_id),
    ),
  });
});
runtimeRoutes.post(
  "/projects/:projectId/runtime/runs/:runId/renew",
  async (c) => {
    await runtimeDescendant(c, c.req.param("runId"));
    const parsed = RuntimeRenewRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return zodValidationError(c, parsed.error);
    const { token, secret } = await runtimeSecret(c);
    const context = await new RuntimeStore(c.env.DB).renew(
      c.req.param("runId"),
      parsed.data.expected_token_id,
      secret,
    );
    return c.json({ ok: true, token, context });
  },
);
runtimeRoutes.post(
  "/projects/:projectId/runtime/runs/:runId/heartbeat",
  async (c) => {
    await runtimeDescendant(c, c.req.param("runId"), true);
    return c.json({
      ok: true,
      lease_expires_at: await new RuntimeStore(c.env.DB).heartbeat(
        c.req.param("runId"),
      ),
    });
  },
);
runtimeRoutes.post(
  "/projects/:projectId/runtime/runs/:runId/close",
  async (c) => {
    await runtimeDescendant(c, c.req.param("runId"), true);
    await new RuntimeStore(c.env.DB).finish(
      c.req.param("runId"),
      principalIdFor(c.get("tokenResult")),
      "closed",
    );
    await expireAgentBindings(c.env, c.get("projectId"), {
      run_id: c.req.param("runId"),
    });
    return c.json({ ok: true });
  },
);
runtimeRoutes.post(
  "/projects/:projectId/runtime/runs/:runId/revoke",
  async (c) => {
    const denied = await runtimeOperator(c, true);
    if (denied) return denied;
    const store = new RuntimeStore(c.env.DB);
    const run = await store.run(c.req.param("runId"));
    if (!run || run.project_id !== c.get("projectId"))
      throw new RuntimeDenied("runtime-binding-mismatch", "Unknown run");
    await store.finish(
      run.run_id,
      principalIdFor(c.get("tokenResult")),
      "revoked",
    );
    await expireAgentBindings(c.env, c.get("projectId"), {
      run_id: run.run_id,
    });
    return c.json({ ok: true });
  },
);
runtimeRoutes.onError(async (error, c) => {
  const token = c.get("tokenResult");
  const authority = token?.kind === "d1-token" ? token.runtime : undefined;
  const reason =
    error instanceof RuntimeDenied
      ? error.code
      : "runtime-authorization-unavailable";
  try {
    c.env.ANALYTICS?.writeDataPoint({
      blobs: ["runtime", "failure", reason, c.req.method],
      doubles: [1],
    });
    if (authority)
      await new RuntimeStore(c.env.DB).recordDenial(
        authority.project_id,
        authority.principal_id,
        authority.run_id ?? authority.enrollment_id ?? authority.principal_id,
        reason,
      );
  } catch {
    /* Denied requests stay denied when audit storage is unavailable. */
  }

  if (error instanceof RuntimeDenied)
    return c.json(
      {
        ok: false,
        error: { code: error.code, message: error.message, retryable: false },
      },
      error.status,
    );
  if (error.message.includes("UNIQUE constraint failed"))
    return c.json(
      {
        ok: false,
        error: {
          code: "runtime-conflict",
          message:
            "Operation already completed; inspect and recover using the same operation ID",
          retryable: false,
        },
      },
      409,
    );
  return c.json(
    {
      ok: false,
      error: {
        code: "runtime-authorization-unavailable",
        message: "Runtime authorization state is unavailable",
        retryable: true,
      },
    },
    503,
  );
});
