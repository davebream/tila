import { RuntimeDenied, RuntimeStore } from "@tila/backend-d1";
import {
  RUNTIME_RUN_CEILING,
  canonicalizeHtu,
  effectiveCredentialPolicy,
  intersectCredentialPolicies,
} from "@tila/schemas";
import type { Context } from "hono";
import { verifyDpopProof } from "../middleware/dpop";
import { resolveTokenMembership } from "../middleware/membership";
import {
  authorizeProtectedOperation,
  requireFreshAuthentication,
} from "../middleware/protected-operation";
import { principalIdFor } from "../middleware/request-identity";
import { requireProjectOwnerHttp } from "../middleware/require-project-owner";
import type { Env, HonoVariables } from "../types";
import { generateToken, hashToken } from "./hash";
import { consumeRuntimeProof } from "./runtime-proof-replay";

type RuntimeHttpContext = Context<{ Bindings: Env; Variables: HonoVariables }>;

export async function runtimeSecret(c: RuntimeHttpContext) {
  const token = await generateToken();
  return {
    token,
    secret: {
      id: crypto.randomUUID(),
      hash: await hashToken(token, c.env.HASH_PEPPER),
    },
  };
}

export function runtimeAuthority(c: RuntimeHttpContext) {
  const token = c.get("tokenResult");
  return token.kind === "d1-token" ? token.runtime : undefined;
}

export async function runtimeOperator(c: RuntimeHttpContext, owner = false) {
  if (runtimeAuthority(c))
    throw new RuntimeDenied(
      "runtime-purpose-denied",
      "Runtime credentials cannot administer installations",
    );
  if (owner)
    return (await requireProjectOwnerHttp(c)) ?? requireFreshAuthentication(c);
  const token = c.get("tokenResult");
  const principal = principalIdFor(token);
  if (!principal.startsWith("github:") && !principal.startsWith("oidc:"))
    throw new RuntimeDenied(
      "runtime-purpose-denied",
      "Personal enrollment requires human authentication; owners can authorize shared installations",
    );
  const membership = await resolveTokenMembership(
    c.env.DB,
    token,
    token.projectId,
  );
  if (!membership)
    throw new RuntimeDenied(
      "membership-required",
      "Project membership is required",
    );
  c.set("effectiveRole", membership.role);
  c.set("explicitRole", membership.explicitRole);
  return (
    (await authorizeProtectedOperation(c, "participant")) ??
    requireFreshAuthentication(c)
  );
}

export function runtimeCeiling(c: RuntimeHttpContext) {
  const token = c.get("tokenResult");
  const policy = "policy" in token ? token.policy : undefined;
  return policy
    ? intersectCredentialPolicies(RUNTIME_RUN_CEILING, policy)
    : effectiveCredentialPolicy(
        RUNTIME_RUN_CEILING,
        c.get("effectiveRole") ?? "owner",
      );
}

export async function runtimeProof(
  c: RuntimeHttpContext,
  jkt: string,
  secret: string,
  header = "DPoP",
) {
  const valid = await verifyDpopProof({
    proofJwt: c.req.header(header) ?? "",
    expectedJkt: jkt,
    accessToken: secret,
    requireAth: true,
    htm: c.req.method,
    htu: canonicalizeHtu(c.req.url),
    nowMs: Date.now(),
    maxAgeMs: 60_000,
    clockSkewMs: 30_000,
  });
  if (!valid.ok)
    throw new RuntimeDenied(
      "runtime-binding-mismatch",
      "Valid installation proof is required",
      401,
    );
  await consumeRuntimeProof(
    c.env.DB,
    jkt,
    c.req.header(header) ?? "",
    c.req.raw,
  );
}

export async function runtimeDescendant(
  c: RuntimeHttpContext,
  runId: string,
  workloadSelf = false,
) {
  const authority = runtimeAuthority(c);
  const row = await new RuntimeStore(c.env.DB).run(runId);
  if (
    workloadSelf &&
    authority?.purpose === "run" &&
    authority.workload_binding_id &&
    authority.run_id === runId &&
    row?.project_id === c.get("projectId")
  )
    return row;
  if (
    authority?.purpose !== "enrollment" ||
    !row ||
    row.project_id !== c.get("projectId") ||
    row.enrollment_id !== authority.enrollment_id
  )
    throw new RuntimeDenied(
      "runtime-purpose-denied",
      "Enrollment can manage only its descendant runs",
    );
  return row;
}

export async function runtimeVisibleEnrollments(c: RuntimeHttpContext) {
  const authority = runtimeAuthority(c);
  const store = new RuntimeStore(c.env.DB);
  if (authority?.purpose === "enrollment")
    return (await store.listEnrollments(c.get("projectId"))).filter(
      (row) => row.enrollment_id === authority.enrollment_id,
    );
  const token = c.get("tokenResult");
  const membership = await resolveTokenMembership(
    c.env.DB,
    token,
    c.get("projectId"),
  );
  if (!membership)
    throw new RuntimeDenied(
      "membership-required",
      "Project membership is required",
    );
  c.set("effectiveRole", membership.role);
  return store.listEnrollments(
    c.get("projectId"),
    membership.role === "owner" ? undefined : principalIdFor(token),
  );
}
