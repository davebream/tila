import { RuntimeDenied, RuntimeStore } from "@tila/backend-d1";
import { type RuntimeContext, RuntimeIdentitySchema } from "@tila/schemas";
import type { Env } from "../types";
import { forwardToDO } from "./do-forward";

export function runtimeIdentity(context: RuntimeContext | undefined) {
  if (context?.purpose !== "run") return null;
  return RuntimeIdentitySchema.parse({
    run_id: context.run_id,
    agent_id: context.agent_id ?? null,
    run_role: context.run_role ?? "acting",
    principal_id: context.principal_id,
    participant_id: context.participant_id,
    enrollment_id: context.enrollment_id,
    workload_binding_id: context.workload_binding_id,
    lease_expires_at: context.lease_expires_at,
  });
}
export function agentRunAuthorizer(env: Env) {
  return async (project: string, principal: string, agent: string) => {
    const stub = env.PROJECT.get(env.PROJECT.idFromName(project));
    const result = await forwardToDO(
      stub,
      `/agents/${encodeURIComponent(agent)}/authorize-run`,
      "POST",
      {},
      undefined,
      undefined,
      {
        "X-Tila-Agent-Authority": JSON.stringify({
          principal_id: principal,
          can_manage: false,
          runtime: null,
        }),
      },
    );
    if (!result.ok)
      throw new RuntimeDenied(
        "runtime-policy-denied",
        "Agent does not authorize this enrollment or workload",
      );
  };
}
export async function expireAgentBindings(
  env: Env,
  project: string,
  selector: {
    run_id?: string;
    enrollment_id?: string;
    workload_binding_id?: string;
    principal_id?: string;
  },
) {
  try {
    const stub = env.PROJECT.get(env.PROJECT.idFromName(project));
    const response = await forwardToDO(
      stub,
      "/agents/internal/expire",
      "POST",
      selector,
      undefined,
      undefined,
      {
        "X-Tila-Agent-Authority": JSON.stringify({
          principal_id: "system:runtime-revocation",
          can_manage: true,
          runtime: null,
        }),
      },
    );
    if (!response.ok) throw new Error("Binding expiry unavailable");
  } catch {
    // D1 revocation remains authoritative on every subsequent request. Failure
    // to update this DO projection must never roll back the revocation.
    console.warn("[runtime] agent binding expiry unavailable");
  }
}

export async function expirePrincipalAgentBindings(
  env: Env,
  project: string,
  principal: string,
) {
  await expireAgentBindings(env, project, { principal_id: principal });
  try {
    for (const enrollment of await new RuntimeStore(env.DB).listEnrollments(
      project,
      principal,
    )) {
      await expireAgentBindings(env, project, {
        enrollment_id: enrollment.enrollment_id,
      });
    }
  } catch {
    console.warn("[runtime] sponsored binding expiry unavailable");
  }
}
