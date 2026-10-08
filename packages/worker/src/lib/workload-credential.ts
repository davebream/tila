import { resolveActionsPolicy } from "@tila/backend-d1";
import {
  CredentialConflict,
  CredentialDenied,
  CredentialStore,
} from "@tila/backend-d1";
import {
  type GitHubActionsContext,
  delegablePolicy,
  effectiveCredentialPolicy,
} from "@tila/schemas";
import { CredentialPolicySchema, roleToPermission } from "@tila/schemas";
import type { Context } from "hono";
import type { Env, HonoVariables } from "../types";
import { generateToken, hashToken } from "./hash";

/** Called only after upstream signature, issuer, audience and provider policy validation. */
async function exchangeScopedWorkloadUnchecked(
  c: Context<{ Bindings: Env; Variables: HonoVariables }>,
  input: {
    projectId: string;
    provider: "github-actions" | "oidc";
    issuer: string;
    subject: string;
    assertionId: string;
    expiresAt: number;
    jkt?: string;
    githubLogin?: string;
    githubRepoId?: number;
    workloadContext?: GitHubActionsContext;
  },
): Promise<Response | null> {
  const store = new CredentialStore(c.env.DB);
  const binding = await store.findBinding(
    input.projectId,
    input.provider,
    input.issuer,
    input.subject,
  );
  if (!binding) return null;
  if (binding.revoked_at !== null)
    return c.json(
      {
        ok: false,
        error: {
          code: "workload-revoked",
          message: "Workload binding is revoked",
          retryable: false,
        },
      },
      403,
    );
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now)
    return c.json(
      {
        ok: false,
        error: {
          code: "oidc-invalid-token",
          message: "Upstream assertion has expired",
          retryable: false,
        },
      },
      401,
    );
  let issuedPolicy = delegablePolicy(
    await store.servicePolicy(
      input.projectId,
      binding.principal_id,
      CredentialPolicySchema.parse(JSON.parse(binding.policy_json)),
    ),
  );
  if (input.provider === "github-actions") {
    if (!input.workloadContext)
      throw new CredentialDenied("Missing workload context");
    const current = await resolveActionsPolicy(
      c.env.DB,
      input.projectId,
      input.workloadContext,
    );
    if (!current) throw new CredentialDenied("Workload policy denied");
    issuedPolicy = effectiveCredentialPolicy(issuedPolicy, current.role);
  }
  const digest = await hashToken(
    `${binding.binding_id}:${input.assertionId}`,
    undefined,
  );
  const name = `workload-${digest}`;
  // An assertion is exchanged once. No bearer secret is persisted in a replay
  // cache; concurrent/retried exchanges receive a conflict rather than re-mint.
  if (await store.hasWorkloadExchange(input.projectId, name))
    return c.json(
      {
        ok: false,
        error: {
          code: "workload-already-exchanged",
          message: "Obtain a new upstream assertion to exchange again",
          retryable: false,
        },
      },
      409,
    );
  const plaintext = await generateToken();
  const tokenHash = await hashToken(plaintext, c.env.HASH_PEPPER);
  const result = await store.issue(
    {
      projectId: input.projectId,
      principalId: binding.principal_id,
      name,
      policy: issuedPolicy,
      expiresAt: Math.min(now + 900, input.expiresAt),
      tokenHash,
      cnfJkt: input.jkt,
      workloadBindingId: binding.binding_id,
      workloadContext: input.workloadContext,
    },
    { principalId: binding.principal_id },
  );
  const effective = await store.resolve(result.token_id);
  if (!effective)
    return c.json(
      {
        ok: false,
        error: {
          code: "workload-revoked",
          message: "Workload membership is no longer active",
          retryable: false,
        },
      },
      403,
    );
  c.header("Cache-Control", "no-store");
  return c.json({
    ok: true,
    session_token: plaintext,
    expires_at: result.expires_at,
    project_id: input.projectId,
    ...(input.provider === "github-actions"
      ? { github_login: input.githubLogin, github_repo_id: input.githubRepoId }
      : {}),
    oidc_issuer: input.issuer,
    oidc_subject: input.subject,
    principal_id: result.principal_id,
    credential_id: result.credential_id,
    token_id: result.token_id,
    role: effective.policy.role,
    permission: roleToPermission(effective.policy.role),
    policy: effective.policy,
    membership_sources: effective.membership.sources,
  });
}

export async function exchangeScopedWorkload(
  c: Parameters<typeof exchangeScopedWorkloadUnchecked>[0],
  input: Parameters<typeof exchangeScopedWorkloadUnchecked>[1],
) {
  try {
    return await exchangeScopedWorkloadUnchecked(c, input);
  } catch (error) {
    if (
      error instanceof CredentialConflict ||
      (error instanceof Error &&
        error.message.includes("UNIQUE constraint failed"))
    )
      return c.json(
        {
          ok: false,
          error: {
            code: "workload-already-exchanged",
            message: "Obtain a new upstream assertion to exchange again",
            retryable: false,
          },
        },
        409,
      );
    if (error instanceof CredentialDenied)
      return c.json(
        {
          ok: false,
          error: {
            code: "workload-revoked",
            message: "Workload membership is no longer active",
            retryable: false,
          },
        },
        403,
      );
    return c.json(
      {
        ok: false,
        error: {
          code: "auth-unavailable",
          message: "Authentication temporarily unavailable",
          retryable: true,
        },
      },
      503,
    );
  }
}
